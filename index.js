const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
const { spawn } = require('child_process');
const settings = require('./settings');

if (!fs.existsSync(settings.WORK_DIR)) {
    fs.mkdirSync(settings.WORK_DIR);
}

const bot = new TelegramBot(settings.BOT_TOKEN, { polling: true });

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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

    const startTime = Date.now();

    await bot.sendMessage(chatId, "⬇️ Downloading project...");

    const file = await bot.getFile(msg.document.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${settings.BOT_TOKEN}/${file.file_path}`;

    const response = await fetch(fileUrl);
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(zipPath, Buffer.from(buffer));

    await bot.sendMessage(chatId, "📦 Extracting project...");
    fs.mkdirSync(projectPath);

    fs.createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: projectPath }))
        .on('close', async () => {

            const statusMsg = await bot.sendMessage(chatId, "🔨 Starting build...\n\n```Initializing...```", {
                parse_mode: "Markdown"
            });

            let buildLog = "";
            let lastUpdate = Date.now();

            const buildProcess = spawn("bash", [
                "-c",
                `cd ${projectPath} && flutter pub get && flutter build apk --release`
            ]);

            buildProcess.stdout.on("data", async (data) => {
                buildLog += data.toString();

                if (Date.now() - lastUpdate > 2000) {
                    lastUpdate = Date.now();

                    let trimmed = buildLog.slice(-3500);

                    try {
                        await bot.editMessageText(
                            "🔨 Building APK...\n\n```" + trimmed + "```",
                            {
                                chat_id: chatId,
                                message_id: statusMsg.message_id,
                                parse_mode: "Markdown"
                            }
                        );
                    } catch (e) {}
                }
            });

            buildProcess.stderr.on("data", async (data) => {
                buildLog += data.toString();
            });

            buildProcess.on("close", async (code) => {

                if (code !== 0) {
                    await bot.editMessageText(
                        "❌ Build gagal!\n\n```" + buildLog.slice(-3500) + "```",
                        {
                            chat_id: chatId,
                            message_id: statusMsg.message_id,
                            parse_mode: "Markdown"
                        }
                    );
                    return;
                }

                const apkPath = path.join(
                    projectPath,
                    "build/app/outputs/flutter-apk/app-release.apk"
                );

                if (fs.existsSync(apkPath)) {

                    await bot.editMessageText(
                        "📤 Uploading APK...",
                        {
                            chat_id: chatId,
                            message_id: statusMsg.message_id
                        }
                    );

                    await bot.sendDocument(chatId, apkPath);

                    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

                    await bot.sendMessage(chatId,
                        `✅ Build selesai!\n⏱ Waktu: ${duration} detik`
                    );

                } else {
                    await bot.sendMessage(chatId, "❌ APK tidak ditemukan.");
                }

                // Cleanup
                fs.rmSync(projectPath, { recursive: true, force: true });
                fs.unlinkSync(zipPath);
            });
        });
});

console.log("🚀 Flutter Build Bot REALTIME running...");
