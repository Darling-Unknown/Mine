const { default: makeWASocket, useMultiFileAuthState, MessageType } = require('@whiskeysockets/baileys');
const fs = require('fs');
const chalk = require('chalk');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;  // Port for Render Web Service

// Set up a simple web server to keep the bot alive 24/7
app.get('/', (req, res) => res.send('WhatsApp Bot is running!'));
app.listen(port, () => console.log(`Server started on port ${port}`));

let mutedUsers = {};  // Store muted users with timestamps

const qrcode = require("qrcode");

let qrCodeDataUrl = ""; // Store the QR Code as a data URL

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
}

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

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    startBot().catch(console.error);
});

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.key.remoteJid.endsWith('@g.us')) return;  // Only for groups

        const from = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid;
        const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const isAdmin = (await sock.groupMetadata(from)).participants.find(p => p.id === sender)?.admin;

        // COMMANDS

        // Mute entire group (Admins only)
        if (body.startsWith('!mute') && isAdmin) {
            sock.groupSettingUpdate(from, 'announcement');  // Make the group announcement-only
            sock.sendMessage(from, { text: '🔇 Group has been muted. Only admins can send messages.' });
        }

        // Unmute entire group (Admins only)
        if (body.startsWith('!unmute') && isAdmin) {
            sock.groupSettingUpdate(from, 'not_announcement');  // Allow all members to send messages
            sock.sendMessage(from, { text: '🔊 Group has been unmuted. Everyone can now send messages.' });
        }

        // Mute a particular user for 2 hours
        if (body.startsWith('!muteuser') && isAdmin) {
            const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
            if (mentioned) {
                mutedUsers[mentioned[0]] = Date.now() + 2 * 60 * 60 * 1000; // Mute for 2 hours
                sock.sendMessage(from, { text: `🔇 @${mentioned[0].split('@')[0]} has been muted for 2 hours.`, mentions: mentioned });
            }
        }

        // Unmute a user
        if (body.startsWith('!unmuteuser') && isAdmin) {
            const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
            if (mentioned) {
                delete mutedUsers[mentioned[0]]; // Remove from muted list
                sock.sendMessage(from, { text: `🔊 @${mentioned[0].split('@')[0]} has been unmuted.`, mentions: mentioned });
            }
        }

        // If user is muted, delete their message
        if (mutedUsers[sender] && Date.now() < mutedUsers[sender]) {
            sock.sendMessage(from, { delete: { remoteJid: from, id: msg.key.id } });
        }

        // If mute time has passed, unmute the user
        if (mutedUsers[sender] && Date.now() >= mutedUsers[sender]) {
            delete mutedUsers[sender];  // Unmute the user after 2 hours
            sock.sendMessage(from, { text: `🔊 @${sender.split('@')[0]} has been automatically unmuted.`, mentions: [sender] });
        }

        // !kick command to remove user from group
        if (body.startsWith('!kick') && isAdmin) {
            const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
            if (mentioned) sock.groupParticipantsUpdate(from, mentioned, 'remove');
        }

        // !add command to add user to group
        if (body.startsWith('!add') && isAdmin) {
            let number = body.split(' ')[1] + '@s.whatsapp.net';
            sock.groupParticipantsUpdate(from, [number], 'add');
        }

        // !promote command to make user admin
        if (body.startsWith('!promote') && isAdmin) {
            const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
            if (mentioned) sock.groupParticipantsUpdate(from, mentioned, 'promote');
        }

        // !demote command to remove admin
        if (body.startsWith('!demote') && isAdmin) {
            const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
            if (mentioned) sock.groupParticipantsUpdate(from, mentioned, 'demote');
        }

        // !desc to change group description
        if (body.startsWith('!desc') && isAdmin) sock.groupUpdateDescription(from, body.slice(6));

        // !subject to change group name
        if (body.startsWith('!subject') && isAdmin) sock.groupUpdateSubject(from, body.slice(9));

        // !admins to list group admins
        if (body.startsWith('!admins')) {
            const metadata = await sock.groupMetadata(from);
            const admins = metadata.participants.filter(p => p.admin);
            let reply = '👮‍♂️ *Group Admins:*\n';
            admins.forEach(admin => { reply += `@${admin.id.split('@')[0]}\n`; });
            sock.sendMessage(from, { text: reply, mentions: admins.map(a => a.id) });
        }

        // !delete to delete a user's message
        if (body.startsWith('!delete') && isAdmin && msg.message.extendedTextMessage) {
            let quoted = msg.message.extendedTextMessage.contextInfo.stanzaId;
            sock.sendMessage(from, { delete: { remoteJid: from, fromMe: false, id: quoted } });
        }

        // !tagall command to tag all members with a custom message from the admin
        if (body.startsWith('!tagall') && isAdmin) {
            const tagMessage = body.slice(8).trim();
            const metadata = await sock.groupMetadata(from);
            const members = metadata.participants;
            let mentioned = members.map(member => member.id);
            let message = `⚡ *Tagging everyone in the group* ⚡\n\n${tagMessage}\n\n`;
            members.forEach(member => {
                message += `@${member.id.split('@')[0]} `;
            });
            sock.sendMessage(from, { text: message, mentions: mentioned });
        }

        // !reply command to reply to a user's message and tag them
        if (body.startsWith('!reply') && msg.message.extendedTextMessage) {
            const quotedMessage = msg.message.extendedTextMessage.contextInfo.stanzaId;
            const quotedSender = msg.message.extendedTextMessage.contextInfo.participant;
            sock.sendMessage(from, {
                text: `@${quotedSender} you said: ${body.slice(7)}`,
                mentions: [quotedSender],
                quotedMessageId: quotedMessage,
            });
        }
    });

    sock.ev.on('group-participants.update', async (update) => {
        let groupId = fs.existsSync('welcome.txt') ? fs.readFileSync('welcome.txt').toString() : null;
        if (groupId && update.id === groupId) {
            const newMember = update.participants[0].split('@')[0];
            if (update.action === 'add') {
                sock.sendMessage(groupId, { text: `👋 Welcome @${newMember}!`, mentions: [update.participants[0]] });
            }
        }
    });
}

startBot().catch(console.error);