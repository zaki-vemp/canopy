package com.canopy.ws

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.annotation.JsonProperty
import com.fasterxml.jackson.annotation.JsonSubTypes
import com.fasterxml.jackson.annotation.JsonTypeInfo
import com.canopy.chat.RichMessageDto
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
        val targetPeerId: String? = null,
        @field:JsonProperty("isTyping")
        @get:JsonProperty("isTyping")
        @param:JsonProperty("isTyping")
        val isTyping: Boolean = false
    ) : WsClientFrame

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class VoiceJoinIn(
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
        val voicePeers: List<VoicePeerDto>
    ) : WsServerFrame

    data class TypingUpdateOut(
        override val type: String = "typing_update",
        val targetPeerId: String?,
        val fromPeerId: String?,
        val typingAliases: List<String>
    ) : WsServerFrame

    data class MessageCreatedOut(
        override val type: String = "message_created",
        val message: RichMessageDto
    ) : WsServerFrame

    data class MessageUpdatedOut(
        override val type: String = "message_updated",
        val message: RichMessageDto
    ) : WsServerFrame

    data class MessageDeletedOut(
        override val type: String = "message_deleted",
        val messageId: Long,
        val senderPeerId: String,
        val recipientPeerId: String?
    ) : WsServerFrame

    data class ReactionUpdatedOut(
        override val type: String = "reaction_updated",
        val message: RichMessageDto
    ) : WsServerFrame

    data class PinUpdatedOut(
        override val type: String = "pin_updated",
        val message: RichMessageDto
    ) : WsServerFrame

    data class PollUpdatedOut(
        override val type: String = "poll_updated",
        val message: RichMessageDto
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
        val voicePeers: List<VoicePeerDto>
    ) : WsServerFrame

    data class WebRtcSignalOut(
        override val type: String = "webrtc_signal",
        val fromPeerId: String,
        val fromAlias: String,
        val signal: Any?
    ) : WsServerFrame

    data class PongOut(
        override val type: String = "pong"
    ) : WsServerFrame
}
