const TelegramBot = require('node-telegram-bot-api');
const AdmZip = require('adm-zip');
const fs = require('fs-extra');
const path = require('path');
const { exec, spawn } = require('child_process');
const rimraf = require('rimraf');
const { v4: uuidv4 } = require('uuid');
const os = require('os');

// Ganti dengan token bot Telegram kamu
const BOT_TOKEN = '8354432194:AAHBSnA2EDbQEJWikFBcD3ImPGpmxZpkE7A';
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const PROCESSING_DIR = path.join(__dirname, 'processing');
const OUTPUT_DIR = path.join(__dirname, 'outputs');

// Buat direktori jika belum ada
fs.ensureDirSync(PROCESSING_DIR);
fs.ensureDirSync(OUTPUT_DIR);

// Inisialisasi bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Store progress untuk setiap user
const userProgress = new Map();

console.log('Bot started!');

// Fungsi untuk mengirim progress
async function sendProgress(chatId, message, progress) {
    try {
        const progressBar = createProgressBar(progress);
        const statusMessage = `${message}\n${progressBar} ${progress}%`;
        
        if (userProgress.has(chatId)) {
            const userData = userProgress.get(chatId);
            if (userData.progressMessageId) {
                await bot.editMessageText(statusMessage, {
                    chat_id: chatId,
                    message_id: userData.progressMessageId
                });
            } else {
                const sentMsg = await bot.sendMessage(chatId, statusMessage);
                userData.progressMessageId = sentMsg.message_id;
            }
        }
    } catch (error) {
        console.error('Error sending progress:', error);
    }
}

// Fungsi membuat progress bar
function createProgressBar(percent) {
    const filled = Math.round(percent / 10);
    const empty = 10 - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
}

// Handler untuk file ZIP
bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    const fileId = msg.document.file_id;
    const fileName = msg.document.file_name;
    const fileSize = msg.document.file_size;

    console.log(`Received file from ${chatId}: ${fileName} (${fileSize} bytes)`);

    // Cek ukuran file
    if (fileSize > MAX_FILE_SIZE) {
        await bot.sendMessage(chatId, '❌ File terlalu besar! Maksimal 100MB.');
        return;
    }

    // Cek ekstensi file
    if (!fileName.endsWith('.zip')) {
        await bot.sendMessage(chatId, '❌ Harap kirim file ZIP yang berisi project Flutter!');
        return;
    }

    // Buat direktori unik untuk user
    const userId = msg.from.id;
    const sessionId = `${userId}_${Date.now()}`;
    const userDir = path.join(PROCESSING_DIR, sessionId);
    const extractDir = path.join(userDir, 'extracted');
    const outputDir = path.join(userDir, 'output');

    fs.ensureDirSync(extractDir);
    fs.ensureDirSync(outputDir);

    // Simpan data user
    userProgress.set(chatId, {
        sessionId,
        userDir,
        extractDir,
        outputDir,
        progressMessageId: null,
        status: 'started',
        startTime: Date.now()
    });

    try {
        // Kirim pesan awal
        const initialMsg = await bot.sendMessage(chatId, '📦 Menerima file...');
        userProgress.get(chatId).progressMessageId = initialMsg.message_id;

        // Download file
        await sendProgress(chatId, '📥 Mendownload file...', 10);
        const fileStream = await bot.getFileStream(fileId);
        const zipPath = path.join(userDir, fileName);
        const writeStream = fs.createWriteStream(zipPath);

        await new Promise((resolve, reject) => {
            fileStream.pipe(writeStream);
            fileStream.on('end', resolve);
            fileStream.on('error', reject);
        });

        // Ekstrak ZIP
        await sendProgress(chatId, '📂 Mengekstrak file...', 20);
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(extractDir, true);

        // Cari file pubspec.yaml
        await sendProgress(chatId, '🔍 Memverifikasi project Flutter...', 30);
        const pubspecPath = findPubspecYaml(extractDir);
        
        if (!pubspecPath) {
            throw new Error('Project Flutter tidak valid: pubspec.yaml tidak ditemukan');
        }

        // Get flutter project root
        const projectRoot = path.dirname(pubspecPath);

        // Install dependencies
        await sendProgress(chatId, '📦 Menginstall dependencies...', 40);
        await runCommand('flutter pub get', projectRoot);

        // Clean project
        await sendProgress(chatId, '🧹 Membersihkan project...', 50);
        await runCommand('flutter clean', projectRoot);

        // Build APK
        await sendProgress(chatId, '🏗️ Membangun APK (Proses ini bisa memakan waktu 5-10 menit)...', 60);
        
        // Build dengan progress tracking
        await buildApkWithProgress(chatId, projectRoot);

        // Cari file APK yang dihasilkan
        await sendProgress(chatId, '🔍 Mencari file APK...', 90);
        const apkPath = await findApkFile(projectRoot);

        if (!apkPath) {
            throw new Error('Gagal menemukan file APK hasil build');
        }

        // Kirim APK
        await sendProgress(chatId, '📤 Mengirim APK...', 95);
        
        // Copy APK ke output directory
        const outputApkPath = path.join(outputDir, path.basename(apkPath));
        await fs.copy(apkPath, outputApkPath);

        // Kirim file APK
        await bot.sendDocument(chatId, outputApkPath, {
            caption: `✅ Build selesai!\nUkuran: ${formatBytes(fs.statSync(outputApkPath).size)}\nWaktu: ${Math.round((Date.now() - userProgress.get(chatId).startTime) / 1000 / 60)} menit`
        });

        // Update progress terakhir
        await sendProgress(chatId, '✅ Build selesai!', 100);

        // Hapus file temporary setelah 5 menit
        setTimeout(() => {
            rimraf.sync(userDir);
            userProgress.delete(chatId);
        }, 5 * 60 * 1000);

    } catch (error) {
        console.error('Error:', error);
        await bot.sendMessage(chatId, `❌ Error: ${error.message}`);
        
        // Cleanup
        if (userProgress.has(chatId)) {
            const userData = userProgress.get(chatId);
            rimraf.sync(userData.userDir);
            userProgress.delete(chatId);
        }
    }
});

// Fungsi untuk mencari pubspec.yaml
function findPubspecYaml(dir) {
    const files = fs.readdirSync(dir);
    
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
            const found = findPubspecYaml(fullPath);
            if (found) return found;
        } else if (file === 'pubspec.yaml') {
            return fullPath;
        }
    }
    
    return null;
}

// Fungsi menjalankan command
function runCommand(command, cwd) {
    return new Promise((resolve, reject) => {
        exec(command, { cwd }, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error executing ${command}:`, error);
                reject(error);
            } else {
                resolve(stdout);
            }
        });
    });
}

// Fungsi build APK dengan progress
function buildApkWithProgress(chatId, cwd) {
    return new Promise((resolve, reject) => {
        const process = spawn('flutter', ['build', 'apk', '--release'], { cwd });
        
        let progress = 60;
        let lastProgress = 60;

        process.stdout.on('data', (data) => {
            const output = data.toString();
            console.log(`Build output: ${output}`);
            
            // Update progress berdasarkan output
            if (output.includes('Running Gradle task')) {
                progress = 70;
            } else if (output.includes('build succeeded')) {
                progress = 85;
            } else if (output.includes('Built')) {
                progress = 90;
            }
            
            if (progress > lastProgress) {
                lastProgress = progress;
                sendProgress(chatId, '🏗️ Membangun APK...', progress);
            }
        });

        process.stderr.on('data', (data) => {
            console.error(`Build error: ${data}`);
        });

        process.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Build gagal dengan code ${code}`));
            }
        });
    });
}

// Fungsi mencari file APK
async function findApkFile(projectRoot) {
    const buildDir = path.join(projectRoot, 'build', 'app', 'outputs', 'flutter-apk');
    
    if (fs.existsSync(buildDir)) {
        const files = fs.readdirSync(buildDir);
        const apkFile = files.find(file => file.endsWith('.apk') && file.includes('release'));
        
        if (apkFile) {
            return path.join(buildDir, apkFile);
        }
    }
    
    // Cari di lokasi lain jika perlu
    const alternativeDirs = [
        path.join(projectRoot, 'build', 'app', 'outputs', 'apk', 'release'),
        path.join(projectRoot, 'build', 'app', 'outputs', 'apk')
    ];
    
    for (const dir of alternativeDirs) {
        if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir);
            const apkFile = files.find(file => file.endsWith('.apk'));
            if (apkFile) {
                return path.join(dir, apkFile);
            }
        }
    }
    
    return null;
}

// Format bytes
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Handler untuk command /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, 
        '🤖 *Flutter APK Builder Bot*\n\n' +
        'Cara penggunaan:\n' +
        '1. Kirim file ZIP project Flutter kamu\n' +
        '2. Tunggu proses build (5-10 menit)\n' +
        '3. Bot akan mengirimkan file APK hasil build\n\n' +
        '⚠️ *Batasan:*\n' +
        '• Maksimal ukuran file: 100MB\n' +
        '• Hanya menerima file ZIP\n' +
        '• Pastikan project Flutter valid\n\n' +
        '📝 *Perintah:*\n' +
        '/start - Mulai bot\n' +
        '/status - Cek status proses\n' +
        '/cancel - Batalkan proses',
        { parse_mode: 'Markdown' }
    );
});

// Handler untuk command /status
bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (userProgress.has(chatId)) {
        const userData = userProgress.get(chatId);
        const elapsed = Math.round((Date.now() - userData.startTime) / 1000 / 60);
        await bot.sendMessage(chatId, `⏳ Proses sedang berjalan...\nWaktu: ${elapsed} menit`);
    } else {
        await bot.sendMessage(chatId, '❌ Tidak ada proses yang sedang berjalan.');
    }
});

// Handler untuk command /cancel
bot.onText(/\/cancel/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (userProgress.has(chatId)) {
        const userData = userProgress.get(chatId);
        rimraf.sync(userData.userDir);
        userProgress.delete(chatId);
        await bot.sendMessage(chatId, '✅ Proses dibatalkan.');
    } else {
        await bot.sendMessage(chatId, '❌ Tidak ada proses yang sedang berjalan.');
    }
});

console.log('Bot is running...');
