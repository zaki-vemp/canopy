package com.canopy.ws

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.annotation.JsonProperty
import com.fasterxml.jackson.annotation.JsonSubTypes
import com.fasterxml.jackson.annotation.JsonTypeInfo
import com.canopy.chat.RichMessageDto
import com.canopy.pods.ChannelDto
import com.canopy.pods.MemberDto
import com.canopy.pods.PodDetailDto
import com.canopy.pods.PodProposalDto

data class VoicePeerDto(
    val peerId: String,
    val alias: String,
    val color: String,
    val muted: Boolean,
    val deafened: Boolean,
    val speaking: Boolean
)

@JsonIgnoreProperties(ignoreUnknown = true)
@JsonTypeInfo(
    use = JsonTypeInfo.Id.NAME,
    include = JsonTypeInfo.As.PROPERTY,
    property = "type",
    defaultImpl = WsClientFrame.UnknownIn::class
)
@JsonSubTypes(
    JsonSubTypes.Type(value = WsClientFrame.TypingIn::class, name = "typing"),
    JsonSubTypes.Type(value = WsClientFrame.VoiceJoinIn::class, name = "voice_join"),
    JsonSubTypes.Type(value = WsClientFrame.VoiceLeaveIn::class, name = "voice_leave"),
    JsonSubTypes.Type(value = WsClientFrame.VoiceStateIn::class, name = "voice_state"),
    JsonSubTypes.Type(value = WsClientFrame.WebRtcSignalIn::class, name = "webrtc_signal"),
    JsonSubTypes.Type(value = WsClientFrame.PingIn::class, name = "ping")
)
sealed interface WsClientFrame {

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class TypingIn(
        val channelId: String = "",
        @field:JsonProperty("isTyping")
        @get:JsonProperty("isTyping")
        @param:JsonProperty("isTyping")
        val isTyping: Boolean = false
    ) : WsClientFrame

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class VoiceJoinIn(
        val voiceChannelId: String = "",
        val muted: Boolean = false,
        val deafened: Boolean = false
    ) : WsClientFrame

    @JsonIgnoreProperties(ignoreUnknown = true)
    class VoiceLeaveIn : WsClientFrame

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class VoiceStateIn(
        val muted: Boolean = false,
        val deafened: Boolean = false,
        val speaking: Boolean = false
    ) : WsClientFrame

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class WebRtcSignalIn(
        val targetPeerId: String = "",
        val voiceChannelId: String = "",
        val signal: Any? = null
    ) : WsClientFrame

    @JsonIgnoreProperties(ignoreUnknown = true)
    class PingIn : WsClientFrame

    @JsonIgnoreProperties(ignoreUnknown = true)
    class UnknownIn : WsClientFrame
}

sealed interface WsServerFrame {
    val type: String

    data class PresenceSnapshotOut(
        override val type: String = "presence_snapshot",
        val podId: String,
        val selfPeerId: String,
        val onlinePeerIds: List<String>,
        val members: List<MemberDto>,
        val voiceRoster: Map<String, List<VoicePeerDto>>
    ) : WsServerFrame

    data class TypingUpdateOut(
        override val type: String = "typing_update",
        val channelId: String,
        val typingAliases: List<String>
    ) : WsServerFrame

    data class MessageCreatedOut(
        override val type: String = "message_created",
        val channelId: String,
        val message: RichMessageDto
    ) : WsServerFrame

    data class ThreadReplyCreatedOut(
        override val type: String = "thread_reply_created",
        val channelId: String,
        val parentMessageId: Long,
        val reply: RichMessageDto,
        val parentReplyCount: Int
    ) : WsServerFrame

    data class MessageUpdatedOut(
        override val type: String = "message_updated",
        val channelId: String,
        val message: RichMessageDto
    ) : WsServerFrame

    data class MessageDeletedOut(
        override val type: String = "message_deleted",
        val channelId: String,
        val messageId: Long,
        val parentMessageId: Long
    ) : WsServerFrame

    data class ReactionUpdatedOut(
        override val type: String = "reaction_updated",
        val channelId: String,
        val message: RichMessageDto
    ) : WsServerFrame

    data class PinUpdatedOut(
        override val type: String = "pin_updated",
        val channelId: String,
        val message: RichMessageDto
    ) : WsServerFrame

    data class PollUpdatedOut(
        override val type: String = "poll_updated",
        val channelId: String,
        val message: RichMessageDto
    ) : WsServerFrame

    data class ChannelCreatedOut(
        override val type: String = "channel_created",
        val channel: ChannelDto
    ) : WsServerFrame

    data class ChannelDeletedOut(
        override val type: String = "channel_deleted",
        val channelId: String
    ) : WsServerFrame

    data class MemberJoinedOut(
        override val type: String = "member_joined",
        val member: MemberDto
    ) : WsServerFrame

    data class MemberLeftOut(
        override val type: String = "member_left",
        val peerId: String,
        val alias: String
    ) : WsServerFrame

    data class MemberKickedOut(
        override val type: String = "member_kicked",
        val peerId: String,
        val alias: String
    ) : WsServerFrame

    data class ProposalUpdatedOut(
        override val type: String = "proposal_updated",
        val proposal: PodProposalDto
    ) : WsServerFrame

    data class PodUpdatedOut(
        override val type: String = "pod_updated",
        val pod: PodDetailDto
    ) : WsServerFrame

    data class VoiceRosterUpdatedOut(
        override val type: String = "voice_roster_updated",
        val voiceRoster: Map<String, List<VoicePeerDto>>
    ) : WsServerFrame

    data class WebRtcSignalOut(
        override val type: String = "webrtc_signal",
        val voiceChannelId: String,
        val fromPeerId: String,
        val fromAlias: String,
        val signal: Any?
    ) : WsServerFrame

    data class PongOut(
        override val type: String = "pong"
    ) : WsServerFrame
}
