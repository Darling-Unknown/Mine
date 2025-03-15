const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const fs = require('fs');
const express = require('express');
const qrcode = require("qrcode");

const app = express();
const port = process.env.PORT || 3000; // Port for Render Web Service
let qrCodeDataUrl = ""; // Store the QR Code as a data URL
let mutedUsers = {}; // Store muted users with timestamps

// Web server to keep bot alive
app.get("/", (req, res) => {
    res.send("Bot is running! Visit <a href='/qr'>/qr</a> to scan the QR code.");
});

app.get("/qr", (req, res) => {
    if (qrCodeDataUrl) {
        res.send(`<img src="${qrCodeDataUrl}" style="width: 300px; height: 300px;">`);
    } else {
        res.send("QR Code is not available yet. Please wait...");
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

// Function to start the bot
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("./session");
    const sock = makeWASocket({ auth: state });

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", async ({ qr, connection }) => {
        if (qr) {
            console.log("Scan the QR Code at /qr");
            qrCodeDataUrl = await qrcode.toDataURL(qr);
        }
        if (connection === "open") {
            console.log("✅ Bot Connected");
        }
    });

    // Listening for messages
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.key.remoteJid.endsWith('@g.us')) return; // Only for groups

        const from = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid;
        const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const metadata = await sock.groupMetadata(from);
        const isAdmin = metadata.participants.find(p => p.id === sender)?.admin;

        // COMMANDS
        if (body.startsWith('!mute') && isAdmin) {
            await sock.groupSettingUpdate(from, { announcement: true });
            await sock.sendMessage(from, { text: '🔇 Group has been muted. Only admins can send messages.' });
        }

        if (body.startsWith('!unmute') && isAdmin) {
            await sock.groupSettingUpdate(from, { announcement: false });
            await sock.sendMessage(from, { text: '🔊 Group has been unmuted. Everyone can now send messages.' });
        }

        if (body.startsWith('!muteuser') && isAdmin) {
            const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
            if (mentioned) {
                mutedUsers[mentioned[0]] = Date.now() + 2 * 60 * 60 * 1000; // Mute for 2 hours
                await sock.sendMessage(from, { text: `🔇 @${mentioned[0].split('@')[0]} has been muted for 2 hours.`, mentions: mentioned });
            }
        }

        if (body.startsWith('!unmuteuser') && isAdmin) {
            const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
            if (mentioned) {
                delete mutedUsers[mentioned[0]];
                await sock.sendMessage(from, { text: `🔊 @${mentioned[0].split('@')[0]} has been unmuted.`, mentions: mentioned });
            }
        }

        // Delete muted user's message
        if (mutedUsers[sender] && Date.now() < mutedUsers[sender]) {
            await sock.sendMessage(from, { delete: msg.key });
        }

        // Auto unmute after timeout
        if (mutedUsers[sender] && Date.now() >= mutedUsers[sender]) {
            delete mutedUsers[sender];
            await sock.sendMessage(from, { text: `🔊 @${sender.split('@')[0]} has been automatically unmuted.`, mentions: [sender] });
        }

        if (body.startsWith('!kick') && isAdmin) {
            const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
            if (mentioned) await sock.groupParticipantsUpdate(from, mentioned, 'remove');
        }

        if (body.startsWith('!add') && isAdmin) {
            let number = body.split(' ')[1] + '@s.whatsapp.net';
            await sock.groupParticipantsUpdate(from, [number], 'add');
        }

        if (body.startsWith('!promote') && isAdmin) {
            const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
            if (mentioned) await sock.groupParticipantsUpdate(from, mentioned, 'promote');
        }

        if (body.startsWith('!demote') && isAdmin) {
            const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
            if (mentioned) await sock.groupParticipantsUpdate(from, mentioned, 'demote');
        }

        if (body.startsWith('!desc') && isAdmin) {
            await sock.groupUpdateDescription(from, body.slice(6));
        }

        if (body.startsWith('!subject') && isAdmin) {
            await sock.groupUpdateSubject(from, body.slice(9));
        }

        if (body.startsWith('!admins')) {
            const admins = metadata.participants.filter(p => p.admin);
            let reply = '👮‍♂️ *Group Admins:*\n';
            admins.forEach(admin => { reply += `@${admin.id.split('@')[0]}\n`; });
            await sock.sendMessage(from, { text: reply, mentions: admins.map(a => a.id) });
        }

        if (body.startsWith('!delete') && isAdmin && msg.message.extendedTextMessage) {
            let quoted = msg.message.extendedTextMessage.contextInfo.stanzaId;
            await sock.sendMessage(from, { delete: { remoteJid: from, fromMe: false, id: quoted } });
        }

        if (body.startsWith('!tagall') && isAdmin) {
            const tagMessage = body.slice(8).trim();
            const members = metadata.participants;
            let mentioned = members.map(member => member.id);
            let message = `⚡ *Tagging everyone in the group* ⚡\n\n${tagMessage}\n\n`;
            members.forEach(member => {
                message += `@${member.id.split('@')[0]} `;
            });
            await sock.sendMessage(from, { text: message, mentions: mentioned });
        }
    });

    // Welcome Message for New Group Members
    sock.ev.on('group-participants.update', async (update) => {
        const from = update.id;
        const newMember = update.participants[0].split('@')[0];
        if (update.action === 'add') {
            await sock.sendMessage(from, { text: `👋 Welcome @${newMember}!`, mentions: [update.participants[0]] });
        }
    });
}

startBot().catch(console.error);