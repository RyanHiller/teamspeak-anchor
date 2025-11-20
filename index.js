import "dotenv/config"
import { Client, Events, GatewayIntentBits, MessageFlags, REST, Routes, SlashCommandBuilder } from "discord.js"
import {
    createAudioPlayer,
    createAudioResource,
    entersState,
    getVoiceConnection,
    joinVoiceChannel,
    StreamType,
    VoiceConnectionStatus,
} from "@discordjs/voice"
import { Readable } from "stream"
import winston from "winston"

// Config
const TOKEN = process.env.DISCORD_TOKEN
const GUILD_ID = process.env.GUILD_ID
const DEFAULT_CHANNEL_ID = process.env.CHANNEL_ID
let targetChannelId = null
let silencePlayer = null

// Logger
const logger = winston.createLogger({
    level: "info",
    format: winston.format.combine(
        winston.format.timestamp({
            format: () => {
                return new Date().toLocaleString("en-US", {
                    timeZone: "America/Denver", // Mountain Time zone (MST/MDT)
                    hour12: false,
                })
            },
        }),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}] ${message}`)
    ),
    transports: [new winston.transports.Console(), new winston.transports.File({ filename: "anchor.log" })],
})

// Discord Client
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
})

// Slash Commands
const commands = [
    new SlashCommandBuilder().setName("anchorstay").setDescription("Tells the anchor bot to stay in your current voice channel."),
    new SlashCommandBuilder().setName("anchorleave").setDescription("Tells the anchor bot to disconnect from its voice channel."),
]

const rest = new REST({ version: "10" }).setToken(TOKEN)

async function registerCommands() {
    try {
        const appId = client.user?.id
        await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), {
            body: commands.map((c) => c.toJSON()),
        })
        logger.info("Slash commands registered.")
    } catch (err) {
        logger.error(`Error registering commands: ${err}`)
    }
}

// Silent Audio
const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe])

function continuousSilenceStream() {
    // Emit silent frame every 20ms
    const stream = new Readable({
        read() {
            setTimeout(() => this.push(SILENCE_FRAME), 20)
        },
    })

    return stream
}

function startSilence(connection) {
    if (silencePlayer) return
    silencePlayer = createAudioPlayer()
    const resource = createAudioResource(continuousSilenceStream(), { inputType: StreamType.Opus })

    silencePlayer.play(resource)
    connection.subscribe(silencePlayer)
    logger.info("Started continuous silent stream.")
}

function stopSilence() {
    if (silencePlayer) {
        silencePlayer.stop()
        silencePlayer = null
        logger.info("Stopped silent stream.")
    }
}

// Voice State Tracking
async function handleVoiceState(channel) {
    const connection = getVoiceConnection(GUILD_ID)
    if (!connection) return

    const members = channel.members.filter((m) => !m.user.bot)
    if (members.size === 0) startSilence(connection)
    else stopSilence()
}

// Connection Handling
function connectToVoice(channel) {
    logger.info(`Connecting to ${channel.name}...`)

    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false,
    })

    connection.on(VoiceConnectionStatus.Ready, () => {
        logger.info("Connected to voice.")
        handleVoiceState(channel)
    })

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        logger.warn("Disconnected! Reconnecting...")
        try {
            await entersState(connection, VoiceConnectionStatus.Connecting, 5000)
        } catch {
            logger.warn("Reconnect failed, rejoining...")
            connectToVoice(channel)
        }
    })

    return connection
}

// Health Check/Rejoin
setInterval(() => {
    if (!targetChannelId) return
    const connection = getVoiceConnection(GUILD_ID)
    const channel = client.channels.cache.get(targetChannelId)
    if (!channel) return

    if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) {
        logger.warn("Rejoining lost connection...")
        connectToVoice(channel)
    } else {
        handleVoiceState(channel)
    }
}, 60000) // Refresh every 60 seconds

// Discord Event Handling
client.once(Events.ClientReady, async () => {
    logger.info(`Logged in as ${client.user.tag}`)

    // Register slash commands
    await registerCommands()

    // Auto join server/channel defined in env when bot starts
    if (GUILD_ID && DEFAULT_CHANNEL_ID) {
        const voiceChannel = client.channels.cache.get(DEFAULT_CHANNEL_ID)
        connectToVoice(voiceChannel)
        logger.info(`Anchored to ${voiceChannel.name} (${DEFAULT_CHANNEL_ID})`)
    }
})

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isCommand()) return
    if (interaction.user.id !== process.env.OWNER_ID) {
        await interaction.reply({ content: "❌ Only the bot owner can use this command.", flags: MessageFlags.Ephemeral })
        return
    }

    const { commandName, guild, user } = interaction

    if (commandName === "anchorstay") {
        const member = await guild.members.fetch(user.id)
        const voiceChannel = member.voice.channel

        if (!voiceChannel) {
            await interaction.reply({
                content: "You must be in a voice channel.",
                ephemeral: true,
            })
            return
        }

        targetChannelId = voiceChannel.id
        connectToVoice(voiceChannel)
        await interaction.reply(`✅ Anchoring to **${voiceChannel.name}**.`)
        logger.info(`Anchored to ${voiceChannel.name} (${voiceChannel.id})`)
    } else if (commandName === "anchorleave") {
        const connection = getVoiceConnection(guild.id)
        if (connection) {
            connection.destroy()
            targetChannelId = null
            logger.info(`Disconnected from voice by ${user.tag}`)
            await interaction.reply({ content: "👋 Disconnected from voice channel." })
        } else {
            await interaction.reply({ content: "🤷‍♂️ The bot isn't connected to any voice channe.", flags: MessageFlags.Ephemeral })
        }
    }
})

// Join/Leave Monitor
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    if (!targetChannelId) return
    const channel = oldState.channelId === targetChannelId ? oldState.channel : newState.channelId === targetChannelId ? newState.channel : null
    if (channel) handleVoiceState(channel)
})

// START
client.login(TOKEN)
