const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const ffmpeg = require('fluent-ffmpeg')
const fs = require('fs')
const path = require('path')
const os = require('os')
const pino = require('pino')

async function connectToWhatsApp() {
  if (process.env.CLEAR_SESSION === 'true') {
    if (fs.existsSync('auth_info')) {
      fs.rmSync('auth_info', { recursive: true })
      console.log('🗑️ Sessão limpa!')
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState('auth_info')

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '22.0.0'],
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        console.log('❌ Deslogado!')
      } else {
        console.log('🔄 Reconectando...')
        setTimeout(() => connectToWhatsApp(), 5000)
      }
    } else if (connection === 'open') {
      console.log('✅ Bot conectado!')
    }
  })

  if (!sock.authState.creds.registered) {
    const phoneNumber = process.env.PHONE_NUMBER
    console.log(`📱 Solicitando código para: ${phoneNumber}`)
    await new Promise(r => setTimeout(r, 8000))
    try {
      const code = await sock.requestPairingCode(phoneNumber)
      console.log(`🔑 Código de pareamento: ${code}`)
    } catch (err) {
      console.error('Erro ao solicitar código:', err.message)
      setTimeout(() => connectToWhatsApp(), 10000)
    }
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
