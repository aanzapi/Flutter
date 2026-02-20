const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
const { exec } = require('child_process');
const settings = require('./settings');

if (!fs.existsSync(settings.WORK_DIR)) {
    fs.mkdirSync(settings.WORK_DIR);
}

const bot = new TelegramBot(settings.BOT_TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "🚀 Kirim file project Flutter (.zip) untuk build APK");
});

bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    const fileName = msg.document.file_name;

    if (!fileName.endsWith('.zip')) {
        return bot.sendMessage(chatId, "❌ Kirim file .zip project Flutter!");
    }

    const projectName = fileName.replace('.zip', '') + "_" + Date.now();
    const projectPath = path.join(settings.WORK_DIR, projectName);
    const zipPath = path.join(settings.WORK_DIR, fileName);

    await bot.sendMessage(chatId, "⬇️ Downloading project...");

    const file = await bot.getFile(msg.document.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${settings.BOT_TOKEN}/${file.file_path}`;

    const response = await fetch(fileUrl);
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(zipPath, Buffer.from(buffer));

    await bot.sendMessage(chatId, "📦 Extracting...");

    fs.mkdirSync(projectPath);

    fs.createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: projectPath }))
        .on('close', async () => {

            await bot.sendMessage(chatId, "🔨 Building APK...");

            exec(`cd ${projectPath} && flutter pub get && flutter build apk --release`, 
            { timeout: settings.BUILD_TIMEOUT }, 
            async (error, stdout, stderr) => {

                if (error) {
                    await bot.sendMessage(chatId, "❌ Build gagal!");
                    console.log(stderr);
                    return;
                }

                const apkPath = path.join(
                    projectPath,
                    "build/app/outputs/flutter-apk/app-release.apk"
                );

                if (fs.existsSync(apkPath)) {
                    await bot.sendDocument(chatId, apkPath);
                    await bot.sendMessage(chatId, "✅ Build selesai!");
                } else {
                    await bot.sendMessage(chatId, "❌ APK tidak ditemukan.");
                }

                // Cleanup
                fs.rmSync(projectPath, { recursive: true, force: true });
                fs.unlinkSync(zipPath);
            });
        });
});

console.log("🤖 Bot running...");
