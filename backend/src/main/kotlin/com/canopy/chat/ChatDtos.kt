package com.canopy.chat

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.annotation.JsonProperty
import com.canopy.pods.DmSummaryDto
import com.canopy.pods.PodProposalDto

data class QuoteSnippetDto(
    val id: Long,
    val senderPeerId: String,
    val senderAlias: String,
    val senderColor: String,
    val body: String,
    val msgType: String,
    @field:JsonProperty("isDeleted")
    @get:JsonProperty("isDeleted")
    @param:JsonProperty("isDeleted")
    val isDeleted: Boolean
)

data class ReactionGroupDto(
    val emoji: String,
    val count: Int,
    val aliases: List<String>,
    val meReacted: Boolean
)

data class AttachmentDto(
    val id: Long,
    val kind: String,
    val fileName: String,
    val mimeType: String,
    val sizeBytes: Long,
    val durationMs: Long,
    val url: String
)

data class PollOptionDto(
    val index: Int,
    val label: String,
    val votes: Int,
    val voters: List<String>,
    val meVoted: Boolean
)

data class PollDto(
    val pollId: Long,
    val question: String,
    @field:JsonProperty("isClosed")
    @get:JsonProperty("isClosed")
    @param:JsonProperty("isClosed")
    val isClosed: Boolean,
    val options: List<PollOptionDto>
)

data class RichMessageDto(
    val id: Long,
    val podId: String,
    val senderPeerId: String,
    val senderAlias: String,
    val senderColor: String,
    val recipientPeerId: String?,
    val recipientAlias: String?,
    val quoteMessage: QuoteSnippetDto?,
    val msgType: String,
    val body: String,
    @field:JsonProperty("isPinned")
    @get:JsonProperty("isPinned")
    @param:JsonProperty("isPinned")
    val isPinned: Boolean,
    @field:JsonProperty("isBookmarked")
    @get:JsonProperty("isBookmarked")
    @param:JsonProperty("isBookmarked")
    val isBookmarked: Boolean,
    @field:JsonProperty("isDeleted")
    @get:JsonProperty("isDeleted")
    @param:JsonProperty("isDeleted")
    val isDeleted: Boolean,
    val editedAt: String?,
    val createdAt: String,
    val reactions: List<ReactionGroupDto>,
    val attachments: List<AttachmentDto>,
    val poll: PollDto?,
    val proposal: PodProposalDto? = null
) {
    fun personalizedForAlias(alias: String): RichMessageDto {
        val updatedReactions = if (reactions.isEmpty()) reactions else reactions.map { r ->
            r.copy(meReacted = alias in r.aliases)
        }
        val updatedPoll = poll?.copy(
            options = poll.options.map { opt -> opt.copy(meVoted = alias in opt.voters) }
        )
        val updatedProposal = proposal?.personalizedForAlias(alias)
        return copy(
            isBookmarked = false,
            reactions = updatedReactions,
            poll = updatedPoll,
            proposal = updatedProposal
        )
    }
}

data class MessagesPageResponse(
    val messages: List<RichMessageDto>,
    val nextBeforeId: Long
)

data class MessagesListResponse(
    val messages: List<RichMessageDto>
)

data class DmConversationsResponse(
    val conversations: List<DmSummaryDto>
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class SendMessageRequest(
    val body: String = "",
    val quoteMessageId: Long = 0L,
    val attachmentIds: List<Long> = emptyList()
)

@JsonInclude(JsonInclude.Include.NON_NULL)
data class SendMessageResponse(
    val message: RichMessageDto? = null,
    val commandHandled: String? = null
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class EditMessageRequest(
    val body: String = ""
)

@JsonInclude(JsonInclude.Include.NON_NULL)
data class SingleMessageResponse(
    val message: RichMessageDto,
    val proposal: PodProposalDto? = null
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class ToggleReactionRequest(
    val emoji: String = ""
)

data class ToggleBookmarkResponse(
    val bookmarked: Boolean,
    val message: RichMessageDto
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class VotePollRequest(
    val optionIndex: Int = 0
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class MarkReadRequest(
    val peerId: String? = null,
    val lastReadMessageId: Long = 0L
)

data class MarkReadResponse(
    val ok: Boolean = true,
    val lastReadMessageId: Long
)

data class MarkAllReadResponse(
    val ok: Boolean = true,
    val updatedConversations: Int
)

internal fun msgTypeToName(code: Int): String = when (code) {
    1 -> "TEXT"
    2 -> "SYSTEM"
    3 -> "POLL"
    4 -> "VOICE_NOTE"
    5 -> "ICEBREAKER"
    6 -> "GOVERNANCE"
    else -> "TEXT"
}
