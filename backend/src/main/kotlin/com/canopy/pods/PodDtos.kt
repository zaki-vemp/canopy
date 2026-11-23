package com.canopy.pods

import com.fasterxml.jackson.annotation.JsonAlias
import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.annotation.JsonProperty
import com.canopy.security.AuthPrincipal
import com.canopy.util.UuidV7
import org.springframework.http.HttpStatus
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.web.server.ResponseStatusException

data class InterestDto(
    val slug: String,
    val label: String,
    val category: String,
    val openPods: Int,
    val activeMembers: Int,
    val selected: Boolean
)

data class InterestsResponse(
    val interests: List<InterestDto>
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class UpdateInterestsRequest(
    val interests: List<String> = emptyList()
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class MatchRequest(
    val interest: String? = null,
    val matchAll: Boolean = false,
    val maxMembers: Int? = null,
    val forceNewPod: Boolean = false,
    val allowAdditional: Boolean = false
)

data class ChannelDto(
    val channelId: String,
    val slug: String,
    val label: String,
    val topic: String,
    val kind: String,
    val position: Int
)

data class MemberDto(
    val peerId: String,
    val alias: String,
    val color: String,
    val role: String = "MEMBER",
    val customStatus: String,
    val online: Boolean,
    val voiceChannelId: String?,
    @field:JsonProperty("isSelf")
    @get:JsonProperty("isSelf")
    @param:JsonProperty("isSelf")
    val isSelf: Boolean
)

data class PodDetailDto(
    val podId: String,
    val code: String,
    val title: String = "",
    val description: String = "",
    val interestSlug: String,
    val interestLabel: String,
    val governanceMode: String = "DEMOCRATIC",
    @field:JsonProperty("isPublicized")
    @get:JsonProperty("isPublicized")
    @param:JsonProperty("isPublicized")
    val isPublicized: Boolean = false,
    val allowRandomMatch: Boolean = true,
    @field:JsonProperty("isOpen")
    @get:JsonProperty("isOpen")
    @param:JsonProperty("isOpen")
    val isOpen: Boolean = true,
    val myPeerId: String,
    val myAlias: String,
    val myColor: String,
    val myRole: String = "MEMBER",
    val myStatus: String,
    val memberCount: Int,
    val maxMembers: Int,
    val openProposalsCount: Int = 0,
    val channels: List<ChannelDto>,
    val members: List<MemberDto>
)

data class MatchResponse(
    val matched: List<PodDetailDto>,
    val pods: List<PodDetailDto>
)

data class PodsListResponse(
    val pods: List<PodDetailDto>
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class CreateChannelRequest(
    val label: String = "",
    val topic: String = "",
    val kind: String = "TEXT"
)

data class CreateChannelResponse(
    val channel: ChannelDto
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class UpdateStatusRequest(
    val customStatus: String = ""
)

data class OkResponse(
    val ok: Boolean = true
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class LeavePodRequest(
    val rematch: Boolean = false,
    val maxMembers: Int? = null,
    val forceNewPod: Boolean = false
)

data class LeavePodResponse(
    val leftPodId: String,
    val newPod: PodDetailDto?
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class CreatePodInviteRequest(
    val maxUses: Int? = 0,
    val expiresInHours: Int? = 168,
    val regenerate: Boolean = false
)

data class PodInviteDto(
    val code: String,
    val podId: String,
    val podCode: String,
    val interestSlug: String,
    val interestLabel: String,
    val invitedByAlias: String,
    val memberCount: Int,
    val maxMembers: Int,
    val maxUses: Int,
    val usesCount: Int,
    val expiresAt: String?,
    val createdAt: String,
    @field:JsonProperty("isExpired")
    @get:JsonProperty("isExpired")
    @param:JsonProperty("isExpired")
    val isExpired: Boolean,
    @field:JsonProperty("isRevoked")
    @get:JsonProperty("isRevoked")
    @param:JsonProperty("isRevoked")
    val isRevoked: Boolean,
    @field:JsonProperty("isFull")
    @get:JsonProperty("isFull")
    @param:JsonProperty("isFull")
    val isFull: Boolean,
    val canAccept: Boolean
)

data class PodInviteResponse(
    val invite: PodInviteDto
)

data class PodInvitesListResponse(
    val invites: List<PodInviteDto>
)

data class AcceptPodInviteResponse(
    val alreadyMember: Boolean,
    val pod: PodDetailDto,
    val pods: List<PodDetailDto>
)

data class PodProposalDto(
    val id: Long,
    val podId: String,
    val kind: String,
    val title: String,
    val reason: String,
    val proposerAlias: String,
    val targetPeerId: String?,
    val targetAlias: String?,
    val status: String,
    val yesCount: Int,
    val noCount: Int,
    val eligibleCount: Int,
    val yesAliases: List<String>,
    val noAliases: List<String>,
    val myVote: Boolean?,
    val expiresAt: String,
    val resolvedAt: String?,
    val createdAt: String
) {
    fun personalizedForAlias(alias: String): PodProposalDto = copy(
        myVote = when {
            alias in yesAliases -> true
            alias in noAliases -> false
            else -> null
        }
    )
}

@JsonIgnoreProperties(ignoreUnknown = true)
data class CreateProposalRequest(
    val kind: String = "",
    val targetPeerId: String? = null,
    val channelId: String? = null,
    val label: String? = null,
    val topic: String? = null,
    val channelKind: String? = "TEXT",
    val maxMembers: Int? = null,
    val locked: Boolean? = null,
    val messageId: Long? = null,
    val reason: String? = "",
    val expiresInMinutes: Int? = 5
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class VoteProposalRequest(
    val vote: Boolean? = null
)

data class ProposalActionResponse(
    val proposal: PodProposalDto,
    val pod: PodDetailDto?
)

data class ProposalsListResponse(
    val proposals: List<PodProposalDto>
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class CreateCustomPodRequest(
    val title: String = "",
    val code: String? = null,
    val interest: String = "",
    val description: String? = "",
    val maxMembers: Int? = 25,
    @field:JsonProperty("isPublicized")
    @get:JsonProperty("isPublicized")
    @param:JsonProperty("isPublicized")
    @param:JsonAlias("publicized")
    val isPublicized: Boolean = false
)

data class CustomPodResponse(
    val pod: PodDetailDto,
    val pods: List<PodDetailDto>
)

data class PublicizedPodDto(
    val podId: String,
    val code: String,
    val title: String,
    val description: String,
    val interestSlug: String,
    val interestLabel: String,
    val founderAlias: String,
    val memberCount: Int,
    val maxMembers: Int,
    val alreadyMember: Boolean
)

data class PublicizedPodsResponse(
    val groups: List<PublicizedPodDto>
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class UpdatePodSettingsRequest(
    val title: String? = null,
    val description: String? = null,
    val maxMembers: Int? = null,
    @field:JsonProperty("isPublicized")
    @get:JsonProperty("isPublicized")
    @param:JsonProperty("isPublicized")
    @param:JsonAlias("publicized")
    val isPublicized: Boolean? = null,
    @field:JsonProperty("isOpen")
    @get:JsonProperty("isOpen")
    @param:JsonProperty("isOpen")
    @param:JsonAlias("open")
    val isOpen: Boolean? = null
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class AdminKickRequest(
    val targetPeerId: String = ""
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class AdminRoleRequest(
    val targetPeerId: String = "",
    val role: String = ""
)

data class PodOnlyResponse(
    val pod: PodDetailDto
)

private val INVITE_CODE_REGEX = Regex("^[a-z0-9-]{6,24}$")

internal fun normalizeInviteCode(raw: String): String {
    val cleaned = raw.trim()
        .substringBefore('?')
        .substringBefore('#')
        .trimEnd('/')
    val segment = cleaned.substringAfterLast('/').trim().lowercase()
    if (!INVITE_CODE_REGEX.matches(segment)) {
        throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid invite code")
    }
    return segment
}

internal fun requirePrincipal(): AuthPrincipal {
    val auth = SecurityContextHolder.getContext().authentication
    val principal = auth?.principal as? AuthPrincipal
    return principal ?: throw ResponseStatusException(HttpStatus.UNAUTHORIZED, "Authentication required")
}

internal fun optionalPrincipal(): AuthPrincipal? {
    return SecurityContextHolder.getContext().authentication?.principal as? AuthPrincipal
}

internal fun parsePublicIdOrBadRequest(hex: String, label: String = "ID"): ByteArray {
    return try {
        UuidV7.fromHex(hex)
    } catch (_: IllegalArgumentException) {
        throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid $label")
    }
}
