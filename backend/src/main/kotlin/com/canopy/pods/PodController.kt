package com.canopy.pods

import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PatchMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api")
class PodController(
    private val blindMatchService: BlindMatchService,
    private val podGovernanceService: PodGovernanceService
) {

    @GetMapping("/interests")
    fun listInterests(): InterestsResponse {
        val userId = optionalPrincipal()?.userId() ?: 0L
        return InterestsResponse(interests = blindMatchService.listInterests(userId))
    }

    @PutMapping("/me/interests")
    fun updateMyInterests(@RequestBody req: UpdateInterestsRequest): InterestsResponse {
        val principal = requirePrincipal()
        return InterestsResponse(
            interests = blindMatchService.updateUserInterests(principal.userId(), req.interests)
        )
    }

    @PostMapping("/pods/match")
    fun matchPods(@RequestBody(required = false) req: MatchRequest?): MatchResponse {
        val principal = requirePrincipal()
        return blindMatchService.matchPods(principal, req ?: MatchRequest())
    }

    @GetMapping("/pods")
    fun listMyPods(): PodsListResponse {
        val principal = requirePrincipal()
        return PodsListResponse(pods = blindMatchService.listUserPods(principal))
    }

    @PostMapping("/pods/{podId}/channels")
    @ResponseStatus(HttpStatus.CREATED)
    fun createChannel(
        @PathVariable podId: String,
        @RequestBody req: CreateChannelRequest
    ): CreateChannelResponse {
        val principal = requirePrincipal()
        return CreateChannelResponse(channel = blindMatchService.createChannel(principal, podId, req))
    }

    @PatchMapping("/pods/{podId}/status")
    fun updatePodStatus(
        @PathVariable podId: String,
        @RequestBody req: UpdateStatusRequest
    ): OkResponse {
        val principal = requirePrincipal()
        blindMatchService.updateStatus(principal, podId, req.customStatus)
        return OkResponse(ok = true)
    }

    @PostMapping("/pods/{podId}/leave")
    fun leavePod(
        @PathVariable podId: String,
        @RequestBody(required = false) req: LeavePodRequest?
    ): LeavePodResponse {
        val principal = requirePrincipal()
        return blindMatchService.leavePod(principal, podId, req ?: LeavePodRequest())
    }

    @PostMapping("/pods/{podId}/invites")
    fun createPodInvite(
        @PathVariable podId: String,
        @RequestBody(required = false) req: CreatePodInviteRequest?
    ): ResponseEntity<PodInviteResponse> {
        val principal = requirePrincipal()
        val (invite, created) = blindMatchService.createPodInvite(
            principal,
            podId,
            req ?: CreatePodInviteRequest()
        )
        val status = if (created) HttpStatus.CREATED else HttpStatus.OK
        return ResponseEntity.status(status).body(PodInviteResponse(invite = invite))
    }

    @GetMapping("/pods/{podId}/invites")
    fun listPodInvites(@PathVariable podId: String): PodInvitesListResponse {
        val principal = requirePrincipal()
        return PodInvitesListResponse(invites = blindMatchService.listPodInvites(principal, podId))
    }

    @DeleteMapping("/pods/{podId}/invites/{code}")
    fun revokePodInvite(
        @PathVariable podId: String,
        @PathVariable code: String
    ): OkResponse {
        val principal = requirePrincipal()
        blindMatchService.revokePodInvite(principal, podId, code)
        return OkResponse(ok = true)
    }

    @GetMapping("/invites/{code}")
    fun getPublicInvite(@PathVariable code: String): PodInviteResponse {
        return PodInviteResponse(invite = blindMatchService.getPublicInvite(code))
    }

    @PostMapping("/invites/{code}/accept")
    fun acceptPodInvite(@PathVariable code: String): AcceptPodInviteResponse {
        val principal = requirePrincipal()
        return blindMatchService.acceptPodInvite(principal, code)
    }

    @GetMapping("/pods/{podId}/proposals")
    fun listPodProposals(@PathVariable podId: String): ProposalsListResponse {
        val principal = requirePrincipal()
        return ProposalsListResponse(proposals = podGovernanceService.listPodProposals(principal, podId))
    }

    @PostMapping("/pods/{podId}/proposals")
    @ResponseStatus(HttpStatus.CREATED)
    fun createPodProposal(
        @PathVariable podId: String,
        @RequestBody req: CreateProposalRequest
    ): ProposalActionResponse {
        val principal = requirePrincipal()
        return podGovernanceService.createProposal(principal, podId, req)
    }

    @PostMapping("/proposals/{proposalId}/vote")
    fun voteProposal(
        @PathVariable proposalId: Long,
        @RequestBody req: VoteProposalRequest
    ): ProposalActionResponse {
        val principal = requirePrincipal()
        return podGovernanceService.voteProposal(principal, proposalId, req)
    }

    @PostMapping("/proposals/{proposalId}/resolve")
    fun resolveProposal(@PathVariable proposalId: Long): ProposalActionResponse {
        val principal = requirePrincipal()
        return podGovernanceService.resolveProposal(principal, proposalId)
    }

    @PostMapping("/pods/custom")
    @ResponseStatus(HttpStatus.CREATED)
    fun createCustomPod(@RequestBody req: CreateCustomPodRequest): CustomPodResponse {
        val principal = requirePrincipal()
        return blindMatchService.createCustomPod(principal, req)
    }

    @GetMapping("/pods/publicized")
    fun listPublicizedPods(
        @RequestParam(name = "interest", required = false) interest: String?
    ): PublicizedPodsResponse {
        val userId = optionalPrincipal()?.userId() ?: 0L
        return PublicizedPodsResponse(groups = blindMatchService.listPublicizedPods(userId, interest))
    }

    @PostMapping("/pods/{podId}/join")
    fun joinPublicizedPod(@PathVariable podId: String): CustomPodResponse {
        val principal = requirePrincipal()
        return blindMatchService.joinPublicizedPod(principal, podId)
    }

    @PatchMapping("/pods/{podId}/settings")
    fun updatePodSettings(
        @PathVariable podId: String,
        @RequestBody req: UpdatePodSettingsRequest
    ): PodOnlyResponse {
        val principal = requirePrincipal()
        return PodOnlyResponse(pod = blindMatchService.updatePodSettings(principal, podId, req))
    }

    @PostMapping("/pods/{podId}/admin/kick")
    fun adminKickMember(
        @PathVariable podId: String,
        @RequestBody req: AdminKickRequest
    ): PodOnlyResponse {
        val principal = requirePrincipal()
        return PodOnlyResponse(pod = blindMatchService.adminKickMember(principal, podId, req))
    }

    @PostMapping("/pods/{podId}/admin/role")
    fun adminUpdateRole(
        @PathVariable podId: String,
        @RequestBody req: AdminRoleRequest
    ): PodOnlyResponse {
        val principal = requirePrincipal()
        return PodOnlyResponse(pod = blindMatchService.adminUpdateRole(principal, podId, req))
    }

    @DeleteMapping("/pods/{podId}/channels/{channelId}")
    fun deletePodChannel(
        @PathVariable podId: String,
        @PathVariable channelId: String
    ): PodOnlyResponse {
        val principal = requirePrincipal()
        return PodOnlyResponse(pod = blindMatchService.deleteChannel(principal, podId, channelId))
    }
}
