const TeleBot = require('telebot');
const config = require('./config.json');
const connectDB = require('./database/connectDB');
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');
const axios = require('axios');

const bot = new TeleBot(config.botToken);

// ========== Reply Store ==========
const replyStore = new Map();
global.functions = { reply: replyStore };

// ========== Message Handler ==========
const message = {
    reply: (text, options = {}) => {
        return bot.sendMessage(options.chatId, text, { replyToMessage: options.replyToMessage });
    },
    stream: ({ url, caption, chatId, replyToMessage, type = "audio" }) => {
        if (type === "video") {
            return bot.sendVideo(chatId, url, { caption }, { replyToMessage });
        } else {
            return bot.sendAudio(chatId, url, { caption }, { replyToMessage });
        }
    },
    unsend: (chatId, messageId) => {
        return bot.deleteMessage(chatId, messageId);
    }
};

// ========== Mongo Connect ==========
connectDB(config.mongoURI).then(async ({ threadModel, userModel }) => {
    console.log('MongoDB connected ✅');

    // === Command Loader ===
    const commands = new Map();
    const aliases = new Map();
    const loadCommands = (dir) => {
        fs.readdirSync(dir).forEach(file => {
            const filePath = path.join(dir, file);
            if (fs.statSync(filePath).isDirectory()) {
                loadCommands(filePath);
            } else if (file.endsWith('.js')) {
                const command = require(filePath);
                if (command.config) {
                    commands.set(command.config.name.toLowerCase(), command);
                    if (command.config.aliases) {
                        command.config.aliases.forEach(alias => aliases.set(alias.toLowerCase(), command.config.name.toLowerCase()));
                    }
                }
            }
        });
    };
    loadCommands(path.join(__dirname, 'scripts/commands'));

    // === Events Loader ===
    const loadEvents = () => {
        const dir = path.join(__dirname, 'scripts/events');
        fs.readdirSync(dir).forEach(file => {
            if (file.endsWith('.js')) {
                const event = require(path.join(dir, file));
                if (event.config && event.onEvent) {
                    bot.on(event.config.name, (msg) => event.onEvent({ msg, bot, config }));
                }
            }
        });
    };
    loadEvents();

    // === Permission Check ===
    const isAdmin = (userId, chatAdmins) => {
        return chatAdmins.some(admin => admin.user.id === userId);
    };

    const isGloballyBanned = async (userId) => {
        try {
            const res = await axios.get('https://raw.githubusercontent.com/notsopreety/Uselessrepo/main/gban.json');
            const banned = res.data.find(user => user.userId === userId);
            return banned || null;
        } catch {
            return null;
        }
    };

    const cooldowns = new Map();

    // === Main Message Listener ===
    bot.on('text', async (msg) => {
        const chatId = msg.chat.id.toString();
        const userId = msg.from.id.toString();
        const text = msg.text;

        // === DB Setup ===
        let thread = await threadModel.findOne({ chatId }) || new threadModel({ chatId });
        let user = await userModel.findOne({ userID: userId }) || new userModel({
            userID: userId,
            username: msg.from.username,
            first_name: msg.from.first_name,
            last_name: msg.from.last_name
        });
        await thread.save();
        await user.save();

        // === Global Ban ===
        const globalBan = await isGloballyBanned(userId);
        if (globalBan) {
            const banTime = moment(globalBan.banTime).format('MMMM Do YYYY, h:mm:ss A');
            return bot.sendPhoto(chatId, globalBan.proof, {
                caption: `🚫 @${msg.from.username} is Globally Banned\nReason: ${globalBan.reason}\nTime: ${banTime}`
            });
        }

        // === Local Ban ===
        if (user.banned) return bot.sendMessage(chatId, '🚫 You are banned from this bot.');

        // === GC Ban ===
        if (thread.users?.get(userId)?.gcBan) return bot.sendMessage(chatId, '🚫 You are banned in this group.');

        // === Reply Handler ===
        if (replyStore.has(msg.reply_to_message?.message_id)) {
            const replyData = replyStore.get(msg.reply_to_message.message_id);
            const command = commands.get(replyData.commandName);
            if (command?.reply) {
                return command.reply({ msg, event: msg, Reply: replyData, message, bot });
            }
        }

        // === onChat Handler ===
        for (let cmd of commands.values()) {
            if (cmd.onChat) {
                cmd.onChat({ event: msg, message, bot, args: text.split(' ') });
            }
        }

        // === Command Handler ===
        if (!text.startsWith(config.prefix)) return;

        const args = text.slice(config.prefix.length).trim().split(/ +/);
        const cmdName = args.shift().toLowerCase();
        const command = commands.get(cmdName) || commands.get(aliases.get(cmdName));

        if (!command) return bot.sendMessage(chatId, '❌ Invalid command');

        // === Permission Check ===
        const chatAdmins = await bot.getChatAdministrators(chatId);
        const isBotAdmin = config.adminId.includes(userId);
        const isGroupAdmin = isAdmin(userId, chatAdmins);

        if (command.config.onlyAdmin && !isBotAdmin) {
            return bot.sendMessage(chatId, '❌ Only bot admins can use this.');
        }
        if (command.config.role === 1 && !isGroupAdmin) {
            return bot.sendMessage(chatId, '❌ Only group admins can use this.');
        }

        // === Cooldown ===
        if (!cooldowns.has(cmdName)) cooldowns.set(cmdName, new Map());
        const timestamps = cooldowns.get(cmdName);
        const now = Date.now();
        const cooldownAmount = (command.config.countDown || 3) * 1000;

        if (timestamps.has(userId)) {
            const expirationTime = timestamps.get(userId) + cooldownAmount;
            if (now < expirationTime) {
                const timeLeft = ((expirationTime - now) / 1000).toFixed(1);
                return bot.sendMessage(chatId, `⏳ Wait ${timeLeft}s before using ${cmdName} again.`);
            }
        }
        timestamps.set(userId, now);
        setTimeout(() => timestamps.delete(userId), cooldownAmount);

        // === Run Command ===
        try {
            if (typeof command.onStart === 'function') {
                await command.onStart({
                    msg, event: msg, bot, args, chatId, userId,
                    message, config, botName: config.botName,
                    senderName: `${msg.from.first_name} ${msg.from.last_name || ''}`,
                    username: msg.from.username,
                    threadModel, userModel, user, thread,
                    api: config.globalapi
                });
            } else if (typeof command.run === 'function') {
                await command.run({
                    msg, event: msg, bot, args, chatId, userId,
                    message, config, botName: config.botName,
                    senderName: `${msg.from.first_name} ${msg.from.last_name || ''}`,
                    username: msg.from.username,
                    threadModel, userModel, user, thread,
                    api: config.globalapi
                });
            } else {
                message.reply('❌ No onStart() or run() function found.', { chatId });
            }
        } catch (e) {
            console.error(e);
            message.reply('❌ Error while executing command.', { chatId });
        }
    });

    bot.start();
    console.log('🤖 Bot Started...');
}).catch(e => {
    console.log('❌ MongoDB Error', e);
});

// === Website Host ===
const http = require('http');
http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<html><body><h1>Bot is Running</h1></body></html>`);
}).listen(config.port || 3000);
