const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const ffmpeg = require('fluent-ffmpeg')
const fs = require('fs')
const path = require('path')
const os = require('os')

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) connectToWhatsApp()
    } else if (connection === 'open') {
      console.log('✅ Bot conectado!')
    }
  })

  // Gera o código de pareamento
  if (!sock.authState.creds.registered) {
    const phoneNumber = process.env.PHONE_NUMBER
    setTimeout(async () => {
      const code = await sock.requestPairingCode(phoneNumber)
      console.log(`🔑 Código de pareamento: ${code}`)
    }, 3000)
  }

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const type = Object.keys(msg.message)[0]
    const isVideo = type === 'videoMessage'
    const isImage = type === 'imageMessage'

    if (!isVideo && !isImage) return

    const jid = msg.key.remoteJid
    await sock.sendMessage(jid, { text: '⏳ Convertendo figurinha...' })

    try {
      const buffer = await sock.downloadMediaMessage(msg)
      const tmpInput = path.join(os.tmpdir(), `input_${Date.now()}.${isImage ? 'jpg' : 'mp4'}`)
      const tmpOutput = path.join(os.tmpdir(), `output_${Date.now()}.webp`)

      fs.writeFileSync(tmpInput, buffer)

      await new Promise((resolve, reject) => {
        ffmpeg(tmpInput).outputOptions([
          '-vcodec', 'libwebp',
          '-vf', isImage
            ? 'scale=512:512:force_original_aspect_ratio=decrease'
            : 'scale=512:512:force_original_aspect_ratio=decrease,fps=15',
          '-loop', '0',
          '-preset', 'default',
          '-an',
          '-vsync', '0',
          '-t', '10'
        ]).toFormat('webp').save(tmpOutput)
          .on('end', resolve)
          .on('error', reject)
      })

      const webpBuffer = fs.readFileSync(tmpOutput)
      await sock.sendMessage(jid, { sticker: webpBuffer })

      fs.unlinkSync(tmpInput)
      fs.unlinkSync(tmpOutput)

    } catch (err) {
      console.error(err)
      await sock.sendMessage(jid, { text: '❌ Erro ao converter. Tente novamente!' })
    }
  })
}

connectToWhatsApp()
