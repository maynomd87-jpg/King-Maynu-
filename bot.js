/**
 * Improved WhatsApp bot (bot.js)
 * - Safer async handling (try/catch)
 * - Permission checks before kicks/deletes/announcement changes
 * - Per-group+user sticker warnings with optional persistence
 * - Avoid repeated Namaz closures via last-trigger tracking (persisted)
 * - Rate-limited group operations
 *
 * Required npm packages:
 *   @whiskeysockets/baileys canvas moment-timezone axios yt-search fs
 *
 * Configure OWNER_IDS and optionally BACKUP_ADMIN_IDS below.
 */

const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys")
const { createCanvas, loadImage } = require("canvas")
const fs = require("fs")
const path = require("path")
const moment = require("moment-timezone")
const axios = require("axios")
const ytSearch = require("yt-search")

// ----------------- CONFIG -----------------
const BOT_NAME = "king Maynu"
const STICKER_WARN_LIMIT = 5
const OWNER_IDS = [ "8801xxxxxxxxx@s.whatsapp.net" ] // replace with your full WhatsApp ID(s)
const BACKUP_ADMIN_IDS = [ /* '8801xxxxxxx@s.whatsapp.net' */ ] // optional: used when trying to recover admin permissions
const DATA_DIR = path.resolve(__dirname, './.bot_data')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

const STICKER_DB = path.join(DATA_DIR, 'stickerWarn.json')
const NAMAZ_DB = path.join(DATA_DIR, 'lastNamazTrigger.json')
// ------------------------------------------

// In-memory caches (persisted to files occasionally)
let stickerWarn = {}
let lastNamazTrigger = {} // { groupId: { prayerKey: "YYYY-MM-DD_HH:mm" } }

// Load persisted state if present
try { if (fs.existsSync(STICKER_DB)) stickerWarn = JSON.parse(fs.readFileSync(STICKER_DB, 'utf8')) } catch(e){ console.error('Failed load sticker DB', e) }
try { if (fs.existsSync(NAMAZ_DB)) lastNamazTrigger = JSON.parse(fs.readFileSync(NAMAZ_DB, 'utf8')) } catch(e){ console.error('Failed load namaz DB', e) }

// Helper persistence (debounced simple)
function saveJson(filePath, obj) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(obj, null, 2))
    } catch (e) {
        console.error('Failed to persist', filePath, e)
    }
}

function safePersistStickerDB() { saveJson(STICKER_DB, stickerWarn) }
function safePersistNamazDB() { saveJson(NAMAZ_DB, lastNamazTrigger) }

// Small sleep util
const sleep = (ms) => new Promise(res => setTimeout(res, ms))

// Create welcome card image (same logic, with try/catch on loadImage)
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
    } catch (e) {
        // Ignore loading failure, leave default background circle
        console.warn('Failed to load profile image for welcome card:', e && e.message)
    }

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

    const pathOut = path.join(DATA_DIR, `welcome_${Date.now()}.png`)
    fs.writeFileSync(pathOut, canvas.toBuffer())
    return pathOut
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_king_maynu')
    const sock = makeWASocket({ auth: state, printQRInTerminal: true, browser: [BOT_NAME, "Chrome", "1.0"] })
    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (u) => {
        if (u.connection === 'open') console.log(`${BOT_NAME} চালু 👑`)
        if (u.qr) console.log('QR code available in terminal')
    })

    // Small helper: check bot admin in a group
    async function isBotAdmin(groupId) {
        try {
            const meta = await sock.groupMetadata(groupId)
            const botId = (sock.user && sock.user.id) ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : null
            if(!botId) return false
            const me = meta.participants.find(p => p.id === botId)
            return !!(me && me.admin)
        } catch (e) {
            console.warn('isBotAdmin failed', e && e.message)
            return false
        }
    }

    // Helper to safely send messages
    async function safeSendMessage(jid, content) {
        try {
            return await sock.sendMessage(jid, content)
        } catch (e) {
            console.warn('sendMessage failed', e && e.message)
            return null
        }
    }

    // Helper to safely remove participants (checks admin first)
    async function safeRemoveParticipants(groupId, participants = []) {
        try {
            if (!participants || participants.length === 0) return
            const can = await isBotAdmin(groupId)
            if (!can) {
                console.warn(`Cannot remove participants in ${groupId}, not admin`)
                return null
            }
            // Baileys expects list of IDs
            return await sock.groupParticipantsUpdate(groupId, participants, "remove")
        } catch (e) {
            console.warn('groupParticipantsUpdate(remove) failed', e && e.message)
            return null
        }
    }

    // Helper to safely change group setting with admin check
    async function safeGroupSettingUpdate(groupId, setting) {
        try {
            const can = await isBotAdmin(groupId)
            if (!can) {
                console.warn(`Cannot change group setting in ${groupId}, not admin`)
                return null
            }
            return await sock.groupSettingUpdate(groupId, setting)
        } catch (e) {
            console.warn('groupSettingUpdate failed', e && e.message)
            return null
        }
    }

    // Debounced persistence interval
    setInterval(() => {
        safePersistStickerDB()
        safePersistNamazDB()
    }, 60_000)

    // Handler: group participants updated (welcome, anti-demote/remove)
    sock.ev.on('group-participants.update', async (anu) => {
        try {
            const groupId = anu.id
            const action = anu.action
            const participants = anu.participants || []
            const meta = await sock.groupMetadata(groupId).catch(()=>null)
            if (!meta && action === 'add') {
                // Non-fatal: cannot create welcome card without metadata
                console.warn('Missing metadata for group add')
            }

            // WELCOME: when someone is added
            if (action === 'add') {
                for (let num of participants) {
                    try {
                        let pp = await sock.profilePictureUrl(num, 'image').catch(() => 'https://i.ibb.co/6FzX5y6/no-profile.jpg')
                        const name = `@${num.split('@')[0]}`
                        const cardPath = await makeWelcomeCard(pp, name, meta ? meta.subject : 'Group', meta ? meta.participants.length : '?')
                        const text = `*আসসালামু আলাইকুম ${name}* 👑\n\n*${meta ? meta.subject : 'Group'}* গ্রুপে তোমাকে স্বাগতম!\n\n> 📜 নিয়ম: Sticker 5 বার = Kick\n> 🚫 Link = Direct Kick\n> 🕌 নামাজের সময় গ্রুপ অফ থাকবে\n\n*Enjoy The Group!*`
                        const imageBuffer = fs.readFileSync(cardPath)
                        await safeSendMessage(groupId, { image: imageBuffer, caption: text, mentions: [num] })
                        fs.unlinkSync(cardPath)
                    } catch (e) {
                        console.warn('Welcome flow failed for', num, e && e.message)
                    }
                    // small delay to avoid spamming
                    await sleep(200)
                }
            }

            // ANTI BOT KICK & ANTI DEMOTE
            // If the bot is removed/demoted, alert the group and optionally try to recover
            if ((action === 'remove' || action === 'demote') && participants && participants.length > 0) {
                try {
                    const botId = (sock.user && sock.user.id) ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : null
                    if (botId && participants.includes(botId)) {
                        await safeSendMessage(groupId, { text: `⚠️ কেউ আমাকে ${BOT_NAME} কে বের/ডিমোট করার চেষ্টা করছে! আমি স্ট্যান্ডবাই করছি.` })
                        // If demoted, try to request backup admins to restore (best-effort)
                        if (action === 'demote') {
                            if (BACKUP_ADMIN_IDS.length > 0) {
                                for (const aid of BACKUP_ADMIN_IDS) {
                                    try {
                                        await safeSendMessage(aid, { text: `⚠️ ${BOT_NAME} was demoted in ${meta ? meta.subject : groupId}. Please check.` })
                                    } catch(e){/* ignore */ }
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.warn('anti-demote failed', e && e.message)
                }
            }
        } catch (e) {
            console.warn('group-participants.update handler failed', e && e.message)
        }
    })

    // Handler: incoming messages
    sock.ev.on('messages.upsert', async (m) => {
        try {
            let msg = m.messages[0]
            if (!msg || !msg.message || msg.key.fromMe) return
            let groupId = msg.key.remoteJid
            if (!groupId || !groupId.endsWith('@g.us')) return
            let sender = msg.key.participant || msg.key.remoteJid
            // Extract text body in a robust way
            let body = ''
            const messageTypes = msg.message
            if (messageTypes.conversation) body = messageTypes.conversation
            else if (messageTypes.extendedTextMessage && messageTypes.extendedTextMessage.text) body = messageTypes.extendedTextMessage.text
            else if (messageTypes.imageMessage && messageTypes.imageMessage.caption) body = messageTypes.imageMessage.caption
            else if (messageTypes.videoMessage && messageTypes.videoMessage.caption) body = messageTypes.videoMessage.caption
            body = (body || '').toString()

            const type = Object.keys(msg.message)[0]

            // AUTO REACTION (best-effort)
            try {
                await sock.sendMessage(groupId, { react: { text: "👑", key: msg.key } })
            } catch (e) {
                // ignore reaction failure
            }

            // STICKER WARNING (per group+user)
            if (type === 'stickerMessage') {
                const key = `${groupId}_${sender}`
                if (!stickerWarn[key]) stickerWarn[key] = 0
                stickerWarn[key]++
                safePersistStickerDB()
                if (stickerWarn[key] >= STICKER_WARN_LIMIT) {
                    await safeSendMessage(groupId, { text: `🚫 @${sender.split('@')[0]} 5 টা Sticker! Kick!`, mentions: [sender] })
                    await safeRemoveParticipants(groupId, [sender])
                    delete stickerWarn[key]
                    safePersistStickerDB()
                } else {
                    await safeSendMessage(groupId, { text: `⚠️ Sticker Warning ${stickerWarn[key]}/${STICKER_WARN_LIMIT} @${sender.split('@')[0]}`, mentions: [sender] })
                }
            }

            // LINK DELETE + KICK
            if (/(https?:\/\/|chat\.whatsapp\.com|wa\.me)/i.test(body)) {
                // Try delete (best-effort) and kick if allowed
                try {
                    // Delete the message locally (Baileys delete format used as in original)
                    await safeSendMessage(groupId, { delete: msg.key }).catch(()=>null)
                } catch(e){}
                await safeSendMessage(groupId, { text: `Link Delete + Kick @${sender.split('@')[0]}`, mentions: [sender] })
                await safeRemoveParticipants(groupId, [sender])
            }

            // SONG search (yt-search)
            if (body.toLowerCase().startsWith("song ")) {
                let q = body.slice(5).trim()
                if (q.length === 0) {
                    await safeSendMessage(groupId, { text: `Usage: song <search terms>` })
                } else {
                    try {
                        const s = await ytSearch(q)
                        const v = s && s.videos && s.videos[0]
                        if (v) await safeSendMessage(groupId, { text: `🎵 *${v.title}*\nLink: ${v.url}\n\n> ${BOT_NAME} দিচ্ছে, ডাউনলোড হচ্ছে...` })
                        else await safeSendMessage(groupId, { text: `No results for "${q}"` })
                    } catch (e) {
                        console.warn('yt-search failed', e && e.message)
                        await safeSendMessage(groupId, { text: `Search failed.` })
                    }
                }
            }

            // ALL KICK - owner-only
            if (body === ".allkick") {
                try {
                    const isOwner = OWNER_IDS.some(id => sender && sender.includes(id.split('@')[0]))
                    if (!isOwner) {
                        await safeSendMessage(groupId, { text: `You are not authorized to run .allkick` })
                    } else {
                        const meta = await sock.groupMetadata(groupId)
                        const mems = meta.participants.filter(p => !p.admin).map(p => p.id)
                        // Safe remove in batches (and rate-limited)
                        for (let i = 0; i < mems.length; i += 5) {
                            const batch = mems.slice(i, i + 5)
                            await safeRemoveParticipants(groupId, batch)
                            await sleep(500) // small pause between batches
                        }
                    }
                } catch (e) {
                    console.warn('.allkick failed', e && e.message)
                }
            }

        } catch (e) {
            console.warn('messages.upsert handler failed', e && e.message)
        }
    })

    // NAMAZ TIME - Auto Group Close (runs every minute, but prevents repeated triggers)
    setInterval(async () => {
        try {
            const res = await axios.get(`http://api.aladhan.com/v1/timingsByCity?city=Chittagong&country=Bangladesh&method=2`).catch(()=>null)
            if (!res || !res.data || !res.data.data || !res.data.data.timings) return
            const timings = res.data.data.timings
            const now = moment().tz("Asia/Dhaka")
            const nowStr = now.format("HH:mm")
            // Map of prayer keys to API fields and cooldown minutes
            const prayerMap = {
                Fajr: { key: 'Fajr', cooldownMinutes: 25 },
                Dhuhr: { key: 'Dhuhr', cooldownMinutes: 25 },
                Asr: { key: 'Asr', cooldownMinutes: 25 },
                Maghrib: { key: 'Maghrib', cooldownMinutes: 25 },
                Isha: { key: 'Isha', cooldownMinutes: 25 }
            }

            for (const [prayer, info] of Object.entries(prayerMap)) {
                const prayerTime = timings[info.key]
                if (!prayerTime) continue
                // prayerTime format is like "05:12" - compare to nowStr
                if (prayerTime === nowStr) {
                    // Trigger only once per group per prayer per day (with cooldown)
                    const groups = await sock.groupFetchAllParticipating().catch(()=>null)
                    if (!groups) return
                    for (const id of Object.keys(groups)) {
                        try {
                            const groupId = id
                            lastNamazTrigger[groupId] = lastNamazTrigger[groupId] || {}
                            const lastKey = lastNamazTrigger[groupId][prayer]
                            const todayKey = `${now.format('YYYY-MM-DD')}_${prayerTime}`
                            // If we've triggered already today for this prayer and time, skip
                            if (lastKey === todayKey) continue
                            // Update immediately to avoid races
                            lastNamazTrigger[groupId][prayer] = todayKey
                            safePersistNamazDB()

                            // Set announcement (close group) if bot is admin
                            const changed = await safeGroupSettingUpdate(groupId, 'announcement')
                            await safeSendMessage(groupId, { text: `🕌 *নামাজের সময়* ${prayerTime}\nগ্রুপ বন্ধ করা হলো। ${info.cooldownMinutes} মিনিট পর খুলবে।\n\n— ${BOT_NAME}` })
                            // Wait cooldown and reopen
                            setTimeout(async () => {
                                await safeGroupSettingUpdate(groupId, 'not_announcement')
                                await safeSendMessage(groupId, { text: `✅ নামাজ শেষ, গ্রুপ খুলে দেওয়া হলো।` })
                            }, info.cooldownMinutes * 60 * 1000)
                            // small delay so we don't hammer changes across all groups at once
                            await sleep(150)
                        } catch (e) {
                            console.warn('Namaz per-group action failed', e && e.message)
                        }
                    }
                    // Break after processing the matched prayer (avoid double-processing)
                    break
                }
            }
        } catch (e) {
            console.warn('Namaz interval failed', e && e.message)
        }
    }, 60_000) // run every minute

    // Graceful cleanup on process exit
    process.on('SIGINT', () => {
        console.log('Saving state and exiting...')
        safePersistStickerDB()
        safePersistNamazDB()
        process.exit(0)
    })
}

startBot().catch(e => {
    console.error('Failed to start bot', e && e.message)
    process.exit(1)
})