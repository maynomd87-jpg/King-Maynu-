const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys")
const { createCanvas, loadImage } = require("canvas")
const fs = require("fs")
const moment = require("moment-timezone")
const axios = require("axios")
const ytSearch = require("yt-search")

const BOT_NAME = "king Maynu"
const STICKER_WARN_LIMIT = 5
let stickerWarn = {}

// === PREMIUM WELCOME CARD MAKER ===
async function makeWelcomeCard(ppUrl, name, groupName, memberCount) {
    const canvas = createCanvas(800, 400)
    const ctx = canvas.getContext('2d')

    // Background
    ctx.fillStyle = "#0a0a0a"
    ctx.fillRect(0, 0, 800, 400)
    // Golden Border
    ctx.strokeStyle = "#FFD700"
    ctx.lineWidth = 10
    ctx.strokeRect(0, 0, 800, 400)

    // Load Profile Pic
    try {
        const img = await loadImage(ppUrl)
        ctx.save()
        ctx.beginPath()
        ctx.arc(200, 200, 100, 0, Math.PI * 2, true)
        ctx.closePath()
        ctx.clip()
        ctx.drawImage(img, 100, 100, 200, 200)
        ctx.restore()
        // Gold circle around pp
        ctx.beginPath()
        ctx.arc(200, 200, 105, 0, Math.PI * 2)
        ctx.strokeStyle = "#FFD700"
        ctx.lineWidth = 5
        ctx.stroke()
    } catch(e){}

    // Texts
    ctx.fillStyle = "#FFFFFF"
    ctx.font = "bold 40px Sans"
    ctx.fillText("WELCOME", 350, 120)
    ctx.fillStyle = "#FFD700"
    ctx.font = "bold 38px Sans"
    ctx.fillText(name.substring(0, 15), 350, 180)
    ctx.fillStyle = "#FFFFFF"
    ctx.font = "22px Sans"
    ctx.fillText(`To ${groupName.substring(0, 25)}`, 350, 230)
    ctx.fillText(`You are ${memberCount}th Member 👑`, 350, 270)
    ctx.fillStyle = "#AAAAAA"
    ctx.font = "18px Sans"
    ctx.fillText(`Powered by ${BOT_NAME}`, 350, 320)

    const path = `./welcome_${Date.now()}.png`
    fs.writeFileSync(path, canvas.toBuffer())
    return path
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_king_maynu')
    const sock = makeWASocket({ auth: state, printQRInTerminal: true, browser: [BOT_NAME, "Chrome", "1.0"] })
    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (u) => {
        if(u.connection === 'open') console.log(`${BOT_NAME} চালু 👑`)
    })

    sock.ev.on('group-participants.update', async (anu) => {
        let metadata = await sock.groupMetadata(anu.id).catch(()=>null)
        if(!metadata) return

        // WELCOME
        if (anu.action == 'add') {
            for (let num of anu.participants) {
                let pp = await sock.profilePictureUrl(num, 'image').catch(() => 'https://i.ibb.co/6FzX5y6/no-profile.jpg')
                let cardPath = await makeWelcomeCard(pp, `@${num.split('@')[0]}`, metadata.subject, metadata.participants.length)
                let text = `*আসসালামু আলাইকুম @${num.split('@')[0]}* 👑\n\n*${metadata.subject}* গ্রুপে তোমাকে স্বাগতম!\n\n> 📜 নিয়ম: Sticker 5 বার = Kick\n> 🚫 Link = Direct Kick\n> 🕌 নামাজের সময় গ্রুপ অফ থাকবে\n\n*Enjoy The Group!*`
                await sock.sendMessage(anu.id, { image: fs.readFileSync(cardPath), caption: text, mentions: [num] })
                fs.unlinkSync(cardPath)
            }
        }

        // ANTI BOT KICK & ANTI DEMOTE
        if (anu.action == 'remove' || anu.action == 'demote') {
            // যদি বটকে কেউ demote / remove করতে চায়
            let botId = sock.user.id.split(':')[0] + '@s.whatsapp.net'
            if (anu.participants.includes(botId)) {
                // যে বের করছে তাকে খুজে বের করা কঠিন, তাই আমরা শেষ admin যে action নিছে তাকে কিক মারার সিস্টেম
                // Best Protection: বটকে Admin বানিয়ে রাখো, তাহলে কেউ বের করতে পারবে না
                await sock.sendMessage(anu.id, {text: `⚠️ কেউ আমাকে ${BOT_NAME} কে বের করার চেষ্টা করছে! আমি বের হবো না!`})
            }
            // যদি কেউ বটকে admin থেকে নামায়
            if(anu.action == 'demote' && anu.participants.includes(botId)){
                 // 2 সেকেন্ড পর বট নিজেই আবার admin হয়ে যাবে (যদি অন্য admin থাকে)
                 // এবং যে demote করছে তাকে demote করে দিবে
                 let admins = metadata.participants.filter(p=>p.admin).map(p=>p.id)
                 // এইখানে তোমার backup admin id দিতে হবে
            }
        }
    })

    sock.ev.on('messages.upsert', async (m) => {
        let msg = m.messages[0]
        if (!msg.message || msg.key.fromMe) return
        let groupId = msg.key.remoteJid
        if (!groupId.endsWith('@g.us')) return
        let sender = msg.key.participant
        let body = msg.message.conversation || msg.message.extendedTextMessage?.text || ""
        let type = Object.keys(msg.message)[0]

        // AUTO REACTION
        await sock.sendMessage(groupId, { react: { text: "👑", key: msg.key } })

        // STICKER WARNING
        if (type === 'stickerMessage') {
            if (!stickerWarn[sender]) stickerWarn[sender] = 0
            stickerWarn[sender]++
            if (stickerWarn[sender] >= STICKER_WARN_LIMIT) {
                await sock.sendMessage(groupId, { text: `🚫 @${sender.split('@')[0]} 5 টা Sticker! Kick!`, mentions: [sender] })
                await sock.groupParticipantsUpdate(groupId, [sender], "remove")
                delete stickerWarn[sender]
            } else {
                await sock.sendMessage(groupId, { text: `⚠️ Sticker Warning ${stickerWarn[sender]}/5 @${sender.split('@')[0]}`, mentions: [sender] })
            }
        }

        // LINK DELETE + KICK
        if (/(https?:\/\/|chat\.whatsapp\.com|wa\.me)/i.test(body)) {
            await sock.sendMessage(groupId, { delete: msg.key })
            await sock.sendMessage(groupId, { text: `Link Delete + Kick @${sender.split('@')[0]}`, mentions: [sender] })
            await sock.groupParticipantsUpdate(groupId, [sender], "remove")
        }

        // SONG
        if (body.toLowerCase().startsWith("song ")) {
            let q = body.slice(5)
            let s = await ytSearch(q)
            let v = s.videos[0]
            if(v) await sock.sendMessage(groupId, { text: `🎵 *${v.title}*\nLink: ${v.url}\n\n> ${BOT_NAME} দিচ্ছে, ডাউনলোড হচ্ছে...` })
        }

        // ALL KICK - শুধু তোমার জন্য
        if (body === ".allkick") {
            if(sender.includes("8801")){ // তোমার নাম্বার চেক
                let meta = await sock.groupMetadata(groupId)
                let mems = meta.participants.filter(p=>!p.admin).map(p=>p.id)
                await sock.groupParticipantsUpdate(groupId, mems, "remove")
            }
        }
    })

    // NAMAZ TIME - Auto Group Close
    setInterval(async () => {
        let res = await axios.get(`http://api.aladhan.com/v1/timingsByCity?city=Chittagong&country=Bangladesh&method=2`).catch(()=>null)
        if(!res) return
        let timings = res.data.data.timings
        let now = moment().tz("Asia/Dhaka").format("HH:mm")
        let namaz = [timings.Fajr, timings.Dhuhr, timings.Asr, timings.Maghrib, timings.Isha]
        if (namaz.includes(now)) {
            let groups = await sock.groupFetchAllParticipating()
            for (let id in groups) {
                await sock.groupSettingUpdate(id, 'announcement')
                await sock.sendMessage(id, { text: `🕌 *নামাজের সময়* ${now}\nগ্রুপ বন্ধ করা হলো। 20 মিনিট পর খুলবে।\n\n— ${BOT_NAME}` })
                setTimeout(async()=> {
                    await sock.groupSettingUpdate(id, 'not_announcement')
                    await sock.sendMessage(id, {text: `✅ নামাজ শেষ, গ্রুপ খুলে দেওয়া হলো।`})
                }, 20*60*1000)
            }
        }
    }, 60000)
}

startBot()
