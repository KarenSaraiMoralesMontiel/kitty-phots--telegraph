const { Telegraf } = require('telegraf')
const dotenv = require('dotenv')
const express = require('express')
dotenv.config()

const app = express()

// Constants
const CHAT_ID = process.env.CHAT_ID
const ALBUM_PROCESSING_DELAY = 1500 // 1.5 seconds
const mediaGroupCache = {}


const createKittyService = require('./services/kittyService')
const kittyService = createKittyService(process.env.KITTY_BACKEND)
// Initialize bot
const bot = new Telegraf(process.env.BOT_TOKEN)

const DEFAULT_MESSAGE = "Please send photos of kitties!"

// Unified reply function with error handling
const safeReply = async (ctx, html, options = {}) => {
  try {
    await ctx.replyWithHTML(html, {
      disable_web_page_preview: true,
      ...options
    })
  } catch (error) {
    console.error('Failed to send message:', error)
    // Fallback to simple text if HTML fails
    await ctx.reply(html.replace(/<[^>]*>?/gm, ''), options)
  }
}

// Enhanced group check with logging
const checkGroupAuthorization = (chat_id) => {
  const isAuthorized = chat_id == CHAT_ID
  if (!isAuthorized) {
    console.log(`❌ Unauthorized access attempt from chat: ${chat_id}`)
  }
  return isAuthorized
}

// Unified photo processor with improved error handling
async function processPhotosBulk(ctx, photos, baseCaption, isAlbum = false) {
  if (!photos?.length) {
    console.error('No photos provided to process')
    await ctx.reply('No photos detected. Please try again.')
    return
  }

  try {
    // 1. Get file links in parallel with error handling
    const fileLinks = await Promise.all(
      photos.map(photo => ctx.telegram.getFileLink(photo.file_id)
        .catch(e => {
          console.error(`Failed to get file link for photo: ${e.message}`)
          return null
        })
      )
    )

    // 2. Prepare valid uploads with metadata
    const validUploads = fileLinks
      .map((link, index) => {
        if (!link) return null
        
        return {
          photo_url: link.href,
          filename: `photo_${Date.now()}_${index}.jpg`,
          caption: isAlbum 
            ? `${baseCaption} (${index + 1}/${photos.length})` 
            : (baseCaption || 'A cutie!'),
          original_photo: photos[index] // Keep reference for error handling
        }
      })
      .filter(Boolean)

    if (!validUploads.length) {
      throw new Error('All photo downloads failed')
    }

    // 3. Upload to Cloudinary
    const uploadResponse = await kittyService.uploadPhotosFromTelegram(validUploads)
    const savedEntries = uploadResponse.public_ids ? uploadResponse.public_ids : 1
    
    // 4. User feedback
    const successCount = savedEntries.length
    const totalCount = validUploads.length
    const user = ctx.message.from
    
    let message = successCount === totalCount
      ? `✅ Successfully saved ${isAlbum ? 'album' : 'photo'}!`
      : `⚠️ Saved ${successCount}/${totalCount} photos`

    await ctx.replyWithHTML(
      `Hello <a href="tg://user?id=${user.id}">${user.first_name || user.username}</a>, ${message}`,
      { reply_to_message_id: ctx.message.message_id }
    )

  } catch (error) {
    console.error('Processing failed:', error.stack)
    await ctx.reply('❌ Failed to save your photos. Our team has been notified.')
    // Consider adding error reporting to Sentry/Logging service here
  }
}

// Album processor with improved cleanup
async function processAlbumBulkOptimized(groupId, ctx) {
  const group = mediaGroupCache[groupId]
  if (!group?.photos?.length) {
    delete mediaGroupCache[groupId]
    return
  }

  try {
    await processPhotosBulk(ctx, group.photos, group.caption, true)
  } catch (error) {
    console.error(`Album ${groupId} processing error:`, error)
    await ctx.reply('❌ Failed to save your album. Please try sending again.')
  } finally {
    delete mediaGroupCache[groupId]
  }
}

// /get command handler
bot.command('/get', async (ctx) => {
  if (!checkGroupAuthorization(ctx.message.chat.id)) return
  
  await safeReply(
    ctx,
    `🐾 Discover adorable kitties! ` +
    `Click <a href="${WEBSITE_URL}">here</a> to see a random photo of kitty`,
    {
      reply_markup: {
        inline_keyboard: [[
          { 
            text: "Open Gallery", 
            url: WEBSITE_URL 
          }
        ]]
      }
    }
  )
})

// Text message handler
bot.on('text', async (ctx) => {
  if (!checkGroupAuthorization(ctx.message.chat.id)) return
  
  await safeReply(
    ctx,
    `Hello <a href="tg://user?id=${ctx.from.id}">${ctx.from.first_name}</a>, ` +
    `${DEFAULT_MESSAGE}`,
    { 
      reply_to_message_id: ctx.message.message_id 
    }
  )
})


// Photo handler with album detection
bot.on('photo', async (ctx) => {
  if (!checkGroupAuthorization(ctx.chat.id)) return

  const photo = ctx.message.photo.slice(-1)[0] // Highest quality photo
  const caption = ctx.message.caption || 'A cutie!'

  if (ctx.message.media_group_id) {
    const groupId = ctx.message.media_group_id
    
    if (!mediaGroupCache[groupId]) {
      mediaGroupCache[groupId] = {
        photos: [],
        caption,
        timer: null
      }
    }

    mediaGroupCache[groupId].photos.push(photo)
    clearTimeout(mediaGroupCache[groupId].timer)
    mediaGroupCache[groupId].timer = setTimeout(
      () => processAlbumBulkOptimized(groupId, ctx),
      ALBUM_PROCESSING_DELAY
    )
    return
  }

  await processPhotosBulk(ctx, [photo], caption)
})

// Text handler
bot.on('text', async (ctx) => {
  if (!checkGroupAuthorization(ctx.message.chat.id)) return
  
  await ctx.replyWithHTML(
    `Hello <a href="tg://user?id=${ctx.from.id}">${ctx.from.first_name}</a>, please send photos of kitties!`,
    { reply_to_message_id: ctx.message.message_id }
  )
})



// Error handling
bot.catch((err, ctx) => {
  console.error('Bot error:', err.stack)
  ctx?.reply?.('⚠️ An unexpected error occurred. Please try again later.')
})

const PORT = process.env.PORT
const RAILWAY_URL = process.env.RAILWAY_STATIC_URL || `https://${process.env.RAILWAY_PROJECT_NAME}.up.railway.app`;

const WEBHOOK_PATH = `/telegraf/${process.env.BOT_TOKEN}`;

app.get('/health', (request, response) => response.send('😻 Bot is healthy'))

// Webhook + Polling hybrid mode
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  
  try {
    await bot.telegram.setWebhook(`${RAILWAY_URL}${WEBHOOK_PATH}`);
    console.log(`Webhook set to: ${RAILWAY_URL}${WEBHOOK_PATH}`);
  } catch (err) {
    console.error('Webhook setup failed:', err.message);
    // Fallback to polling if webhook fails
    bot.launch().then(() => console.log('Fallback to polling mode'));
  }
});

// Error handling
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));