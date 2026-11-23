package com.canopy.chat

import com.canopy.pods.OkResponse
import com.canopy.pods.PodGovernanceService
import com.canopy.pods.requirePrincipal
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PatchMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api")
class ChatController(
    private val richChatService: RichChatService,
    private val podGovernanceService: PodGovernanceService
) {

    @GetMapping("/pods/{podId}/channels/{channelId}/messages")
    fun listChannelMessages(
        @PathVariable podId: String,
        @PathVariable channelId: String,
        @RequestParam(defaultValue = "0") beforeId: Long,
        @RequestParam(defaultValue = "40") limit: Int
    ): MessagesPageResponse {
        val principal = requirePrincipal()
        return richChatService.listChannelMessages(principal, podId, channelId, beforeId, limit)
    }

    @GetMapping("/pods/{podId}/channels/{channelId}/threads/{parentMessageId}")
    fun getThread(
        @PathVariable podId: String,
        @PathVariable channelId: String,
        @PathVariable parentMessageId: Long
    ): ThreadResponse {
        val principal = requirePrincipal()
        return richChatService.getThread(principal, podId, channelId, parentMessageId)
    }

    @PostMapping("/pods/{podId}/channels/{channelId}/messages")
    fun sendMessage(
        @PathVariable podId: String,
        @PathVariable channelId: String,
        @RequestBody req: SendMessageRequest
    ): ResponseEntity<SendMessageResponse> {
        val principal = requirePrincipal()
        val res = richChatService.sendMessage(principal, podId, channelId, req)
        val status = if (res.commandHandled != null && res.message == null) HttpStatus.OK else HttpStatus.CREATED
        return ResponseEntity.status(status).body(res)
    }

    @PatchMapping("/messages/{messageId}")
    fun editMessage(
        @PathVariable messageId: Long,
        @RequestBody req: EditMessageRequest
    ): SingleMessageResponse {
        val principal = requirePrincipal()
        return SingleMessageResponse(message = richChatService.editMessage(principal, messageId, req))
    }

    @DeleteMapping("/messages/{messageId}")
    fun deleteMessage(@PathVariable messageId: Long): OkResponse {
        val principal = requirePrincipal()
        richChatService.deleteMessage(principal, messageId)
        return OkResponse(ok = true)
    }

    @PostMapping("/messages/{messageId}/reactions")
    fun toggleReaction(
        @PathVariable messageId: Long,
        @RequestBody req: ToggleReactionRequest
    ): SingleMessageResponse {
        val principal = requirePrincipal()
        return SingleMessageResponse(message = richChatService.toggleReaction(principal, messageId, req.emoji))
    }

    @PostMapping("/messages/{messageId}/pin")
    fun togglePin(@PathVariable messageId: Long): SingleMessageResponse {
        val principal = requirePrincipal()
        return podGovernanceService.togglePinOrPropose(principal, messageId)
    }

    @PostMapping("/messages/{messageId}/bookmark")
    fun toggleBookmark(@PathVariable messageId: Long): ToggleBookmarkResponse {
        val principal = requirePrincipal()
        return richChatService.toggleBookmark(principal, messageId)
    }

    @PostMapping("/polls/{pollId}/vote")
    fun votePoll(
        @PathVariable pollId: Long,
        @RequestBody req: VotePollRequest
    ): SingleMessageResponse {
        val principal = requirePrincipal()
        return SingleMessageResponse(message = richChatService.votePoll(principal, pollId, req.optionIndex))
    }

    @GetMapping("/pods/{podId}/pins")
    fun listPodPins(@PathVariable podId: String): MessagesListResponse {
        val principal = requirePrincipal()
        return MessagesListResponse(messages = richChatService.listPodPins(principal, podId))
    }

    @GetMapping("/bookmarks")
    fun listBookmarks(): MessagesListResponse {
        val principal = requirePrincipal()
        return MessagesListResponse(messages = richChatService.listBookmarks(principal))
    }

    @GetMapping("/pods/{podId}/search")
    fun searchPodMessages(
        @PathVariable podId: String,
        @RequestParam(name = "q", defaultValue = "") q: String
    ): MessagesListResponse {
        val principal = requirePrincipal()
        return MessagesListResponse(messages = richChatService.searchPodMessages(principal, podId, q))
    }
}
