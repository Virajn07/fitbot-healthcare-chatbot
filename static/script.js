(() => {
    const boot = window.__FITBOT__;
    if (!boot) return;

    const byId = (id) => document.getElementById(id);
    const shell = document.querySelector(".chat-shell");
    const input = byId("user_input");
    const sendButton = byId("send_button");
    const messages = byId("messages");
    const emptyState = byId("empty_state");
    const conversationList = byId("conversation_list");
    const heading = byId("conversation_heading");
    const newChatButton = byId("new_chat_button");
    const deleteButton = byId("delete_chat_button");
    const languageSelect = byId("language_select");
    const healthButton = byId("health_check_button");
    const modelStatus = byId("model_status");
    const sidebarToggle = byId("sidebar_toggle");

    let activeConversationId = Number(boot.activeConversationId);
    let loadSequence = 0;
    let isSending = false;
    let isDeleting = false;
    let toastTimer = null;

    const savedLanguage = localStorage.getItem("fitbot-language");
    if (savedLanguage && Array.from(languageSelect.options).some((option) => option.value === savedLanguage)) {
        languageSelect.value = savedLanguage;
    }

    sendButton.addEventListener("click", sendMessage);
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            sendMessage();
        }
    });
    input.addEventListener("input", resizeInput);
    newChatButton.addEventListener("click", createConversation);
    deleteButton.addEventListener("click", deleteActiveConversation);
    healthButton.addEventListener("click", checkHealth);
    languageSelect.addEventListener("change", () => localStorage.setItem("fitbot-language", languageSelect.value));

    conversationList.addEventListener("click", (event) => {
        const button = event.target.closest("[data-conversation-id]");
        if (!button) return;
        const id = Number(button.dataset.conversationId);
        if (!Number.isFinite(id) || id === activeConversationId) {
            closeSidebar();
            return;
        }
        setActiveConversation(id);
        closeSidebar();
        loadConversation(id);
    });

    byId("suggestions").addEventListener("click", (event) => {
        const card = event.target.closest("[data-prompt]");
        if (!card || isSending) return;
        input.value = card.dataset.prompt || "";
        resizeInput();
        sendMessage();
    });

    sidebarToggle.addEventListener("click", () => {
        const open = shell.classList.toggle("sidebar-open");
        sidebarToggle.setAttribute("aria-expanded", String(open));
    });
    shell.addEventListener("click", (event) => {
        if (event.target === shell && shell.classList.contains("sidebar-open")) closeSidebar();
    });

    async function sendMessage() {
        const text = input.value.trim();
        if (!text || isSending || isDeleting) return;

        isSending = true;
        const sentToConversation = activeConversationId;
        const sequence = loadSequence;
        input.value = "";
        resizeInput();
        setSendingState(true);
        if (emptyState) emptyState.hidden = true;
        appendMessage(text, "user");
        const pending = createPendingMessage();
        messages.appendChild(pending.row);
        scrollToBottom();

        const payload = new URLSearchParams({
            conversation_id: String(sentToConversation),
            user_input: text,
            language: languageSelect.value,
        });
        const waitTimer = window.setTimeout(() => {
            if (pending.note.isConnected) pending.showWaiting();
        }, 15000);

        try {
            const response = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: payload.toString(),
            });
            const data = await consumeChatStream(response, pending);

            const conversation = data.conversation;
            if (conversation) {
                syncConversationItem(conversation);
                if (Number(conversation.id) === activeConversationId) setHeading(conversation.title);
            }

            // A user can switch chats while a provider is generating. Only replace the view
            // if it still shows the conversation that received this message.
            if (sequence === loadSequence && activeConversationId === sentToConversation) {
                renderMessages(data.messages || []);
            }
            if (data.error) {
                showToast("Neither the primary provider nor the local backup could finish this reply. Check provider status below.");
                checkHealth();
            } else if (data.provider === "ollama" && boot.openrouterConfigured) {
                showToast("OpenRouter was unavailable, so FitBot replied with the local Ollama backup.");
            }
        } catch (error) {
            if (sequence === loadSequence && activeConversationId === sentToConversation) {
                const partial = pending.getContent();
                pending.row.remove();
                appendMessage(`${partial ? `${partial}\n\n` : ""}I couldn’t finish that reply. Check the chat provider status below, then try again.`, "assistant");
                input.value = text;
                resizeInput();
            }
            showToast(error.message || "The message could not be sent.");
        } finally {
            window.clearTimeout(waitTimer);
            pending.row.remove();
            isSending = false;
            setSendingState(false);
        }
    }

    async function consumeChatStream(response, pending) {
        if (!response.ok) {
            let message = "Your message could not be sent. Please try again.";
            try {
                const data = await response.json();
                message = data.error || message;
            } catch (_error) { /* Keep the general error when the server sends no JSON. */ }
            throw new Error(message);
        }

        if (!response.body) throw new Error("This browser could not read the chat response.");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let result = null;

        function handleLine(line) {
            if (!line.trim()) return;
            const event = JSON.parse(line);
            if (event.type === "provider") pending.setProvider(event.label || "FitBot");
            if (event.type === "status") pending.setStatus(event.message || "Preparing a more detailed reply; this may take longer.");
            if (event.type === "reset") pending.reset();
            if (event.type === "token") pending.addToken(event.content || "");
            if (event.type === "done") result = event;
        }

        while (true) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            lines.forEach(handleLine);
            if (done) break;
        }
        if (buffer.trim()) handleLine(buffer);
        if (!result) throw new Error("The chat ended before FitBot finished its reply.");
        return result;
    }

    async function createConversation() {
        if (newChatButton.disabled) return;
        newChatButton.disabled = true;
        try {
            const response = await fetch("/api/conversations", { method: "POST" });
            const data = await response.json();
            if (!response.ok || !data.conversation) throw new Error(data.error || "Could not start a new chat.");
            const conversation = data.conversation;
            loadSequence += 1;
            activeConversationId = Number(conversation.id);
            syncConversationItem(conversation, true);
            setHeading(conversation.title);
            renderMessages([]);
            closeSidebar();
            input.focus();
        } catch (error) {
            showToast(error.message || "Could not start a new chat.");
        } finally {
            newChatButton.disabled = false;
        }
    }

    async function loadConversation(id) {
        const sequence = ++loadSequence;
        const item = (boot.conversations || []).find((entry) => Number(entry.id) === Number(id));
        const currentItem = conversationList.querySelector(`[data-conversation-id="${Number(id)}"]`);
        setHeading(currentItem?.querySelector(".conversation-title")?.textContent || item?.title || "Conversation");
        try {
            const response = await fetch(`/api/conversations/${encodeURIComponent(id)}/messages`, { cache: "no-store" });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "Could not load this chat.");
            if (sequence !== loadSequence || Number(id) !== activeConversationId) return;
            renderMessages(data.messages || []);
        } catch (error) {
            if (sequence === loadSequence) showToast(error.message || "Could not load this chat.");
        }
    }

    async function deleteActiveConversation() {
        if (!activeConversationId || deleteButton.disabled || isSending || isDeleting) return;
        if (!window.confirm("Delete this conversation and its messages? This cannot be undone.")) return;
        isDeleting = true;
        setSendingState(true);
        try {
            const response = await fetch(`/api/conversations/${encodeURIComponent(activeConversationId)}`, { method: "DELETE" });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "Could not delete this chat.");
            loadSequence += 1;
            activeConversationId = Number(data.active_conversation_id);
            rebuildConversationList(data.conversations || [], activeConversationId);
            const active = (data.conversations || []).find((item) => Number(item.id) === activeConversationId);
            setHeading(active?.title || "New conversation");
            renderMessages(data.messages || []);
        } catch (error) {
            showToast(error.message || "Could not delete this chat.");
        } finally {
            isDeleting = false;
            setSendingState(false);
        }
    }

    async function checkHealth() {
        healthButton.disabled = true;
        modelStatus.textContent = "Checking chat providers…";
        healthButton.classList.remove("status-ok", "status-error");
        try {
            const response = await fetch("/api/health", { cache: "no-store" });
            const data = await response.json();
            modelStatus.textContent = data.label || "Chat provider status unavailable.";
            healthButton.classList.add(response.ok && data.ok ? "status-ok" : "status-error");
            const installed = data.models?.length ? `\nOllama models: ${data.models.join(", ")}` : "\nNo Ollama models detected.";
            healthButton.title = `${data.message || "Check provider settings."}${installed}`;
        } catch (_error) {
            modelStatus.textContent = "Can’t check chat providers.";
            healthButton.classList.add("status-error");
        } finally {
            healthButton.disabled = false;
        }
    }

    function renderMessages(items) {
        messages.replaceChildren();
        if (emptyState) {
            emptyState.hidden = items.length > 0;
            messages.appendChild(emptyState);
        }
        items.forEach((item) => appendMessage(item.content, item.role));
        scrollToBottom();
    }

    function appendMessage(content, role) {
        const isUser = role === "user";
        const row = document.createElement("article");
        row.className = `message-row ${isUser ? "user-message" : "assistant-message"}`;
        if (!isUser) {
            const avatar = document.createElement("div");
            avatar.className = "assistant-avatar";
            avatar.setAttribute("aria-hidden", "true");
            avatar.textContent = "+";
            row.appendChild(avatar);
        }
        const stack = document.createElement("div");
        stack.className = "message-stack";
        const meta = document.createElement("div");
        meta.className = "message-meta";
        meta.textContent = isUser ? "You" : "FitBot";
        const bubble = document.createElement("div");
        bubble.className = "message-bubble";
        if (isUser) bubble.textContent = String(content ?? "");
        else renderMarkdown(bubble, content);
        stack.append(meta, bubble);
        row.appendChild(stack);
        messages.appendChild(row);
        scrollToBottom();
        return row;
    }

    // Render the small Markdown subset used by model replies with DOM nodes only.
    // This keeps headings/lists readable and makes raw HTML in a model reply inert.
    function appendInline(parent, text) {
        const value = String(text ?? "");
        const pattern = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;
        let cursor = 0;
        let match;
        while ((match = pattern.exec(value)) !== null) {
            if (match.index > cursor) parent.appendChild(document.createTextNode(value.slice(cursor, match.index)));
            const token = match[0];
            const node = document.createElement(token.startsWith("**") ? "strong" : token.startsWith("`") ? "code" : "em");
            node.textContent = token.startsWith("**") ? token.slice(2, -2) : token.slice(1, -1);
            parent.appendChild(node);
            cursor = pattern.lastIndex;
        }
        if (cursor < value.length) parent.appendChild(document.createTextNode(value.slice(cursor)));
    }

    function renderMarkdown(target, content) {
        target.replaceChildren();
        const lines = String(content ?? "").replace(/\r\n?/g, "\n").split("\n");
        const isUnordered = (line) => /^\s*[-*+]\s+/.test(line);
        const isOrdered = (line) => /^\s*\d+[.)]\s+/.test(line);
        const isSpecial = (line) => /^\s*#{1,3}\s+/.test(line) || isUnordered(line) || isOrdered(line) || /^\s*(?:---+|\*\*\*+)\s*$/.test(line);
        let index = 0;
        while (index < lines.length) {
            if (!lines[index].trim()) { index += 1; continue; }
            if (/^\s*(?:---+|\*\*\*+)\s*$/.test(lines[index])) {
                target.appendChild(document.createElement("hr"));
                index += 1;
                continue;
            }
            const heading = lines[index].match(/^\s*(#{1,3})\s+(.+)$/);
            if (heading) {
                const node = document.createElement(heading[1].length === 1 ? "h3" : "h4");
                appendInline(node, heading[2]);
                target.appendChild(node);
                index += 1;
                continue;
            }
            const listKind = isOrdered(lines[index]) ? "ol" : isUnordered(lines[index]) ? "ul" : null;
            if (listKind) {
                const list = document.createElement(listKind);
                while (index < lines.length && (listKind === "ol" ? isOrdered(lines[index]) : isUnordered(lines[index]))) {
                    const item = lines[index].replace(listKind === "ol" ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/, "");
                    const entry = document.createElement("li");
                    appendInline(entry, item);
                    list.appendChild(entry);
                    index += 1;
                }
                target.appendChild(list);
                continue;
            }
            const paragraph = document.createElement("p");
            const paragraphLines = [];
            while (index < lines.length && lines[index].trim() && !isSpecial(lines[index])) {
                paragraphLines.push(lines[index].trim());
                index += 1;
            }
            appendInline(paragraph, paragraphLines.join(" "));
            target.appendChild(paragraph);
        }
    }

    function createPendingMessage() {
        const row = document.createElement("article");
        row.className = "message-row assistant-message pending-message";
        const avatar = document.createElement("div");
        avatar.className = "assistant-avatar";
        avatar.setAttribute("aria-hidden", "true");
        avatar.textContent = "+";
        const stack = document.createElement("div");
        stack.className = "message-stack";
        const meta = document.createElement("div");
        meta.className = "message-meta";
        meta.textContent = "FitBot is thinking";
        const bubble = document.createElement("div");
        bubble.className = "message-bubble";
        const dots = document.createElement("span");
        dots.className = "typing-dots";
        dots.setAttribute("aria-label", "Generating a reply");
        for (let i = 0; i < 3; i += 1) dots.appendChild(document.createElement("span"));
        const note = document.createElement("span");
        note.className = "wait-note";
        note.hidden = true;
        note.setAttribute("role", "status");
        note.setAttribute("aria-live", "polite");
        note.textContent = "Still working on your reply. Keep the chat open; FitBot will show the answer here when it is ready.";
        bubble.append(dots, note);
        stack.append(meta, bubble);
        row.append(avatar, stack);
        let answer = "";
        let hasExplicitStatus = false;
        return {
            row,
            note,
            showWaiting() {
                if (!hasExplicitStatus) note.hidden = false;
            },
            setStatus(message) {
                hasExplicitStatus = true;
                note.textContent = message;
                note.hidden = false;
            },
            addToken(token) {
                if (!token) return;
                answer += token;
                note.hidden = true;
                meta.textContent = "FitBot";
                renderMarkdown(bubble, answer);
                if (row.isConnected) scrollToBottom();
            },
            setProvider(label) {
                meta.textContent = label;
            },
            reset() {
                answer = "";
                bubble.replaceChildren(dots, note);
                meta.textContent = "Switching provider…";
            },
            getContent() { return answer; },
        };
    }

    function syncConversationItem(conversation, activate = false) {
        let button = conversationList.querySelector(`[data-conversation-id="${Number(conversation.id)}"]`);
        if (!button) {
            const noChats = byId("no_chats");
            if (noChats) noChats.remove();
            button = document.createElement("button");
            button.type = "button";
            button.className = "conversation-item";
            button.dataset.conversationId = String(conversation.id);
            const icon = document.createElement("span");
            icon.className = "conversation-icon";
            icon.setAttribute("aria-hidden", "true");
            icon.textContent = "◷";
            const title = document.createElement("span");
            title.className = "conversation-title";
            button.append(icon, title);
            conversationList.prepend(button);
        }
        const title = button.querySelector(".conversation-title") || button;
        title.textContent = conversation.title || "New conversation";
        button.title = conversation.title || "New conversation";
        conversationList.prepend(button);
        if (activate || Number(conversation.id) === activeConversationId) {
            setActiveConversation(Number(conversation.id));
        }
    }

    function rebuildConversationList(items, activeId) {
        conversationList.replaceChildren();
        items.forEach((conversation) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "conversation-item";
            button.dataset.conversationId = String(conversation.id);
            button.title = conversation.title;
            const icon = document.createElement("span");
            icon.className = "conversation-icon";
            icon.setAttribute("aria-hidden", "true");
            icon.textContent = "◷";
            const title = document.createElement("span");
            title.className = "conversation-title";
            title.textContent = conversation.title;
            button.append(icon, title);
            conversationList.appendChild(button);
        });
        if (!items.length) {
            const empty = document.createElement("p");
            empty.id = "no_chats";
            empty.className = "no-chats";
            empty.textContent = "Your conversations will appear here.";
            conversationList.appendChild(empty);
        }
        setActiveConversation(Number(activeId));
    }

    function setActiveConversation(id) {
        activeConversationId = Number(id);
        conversationList.querySelectorAll("[data-conversation-id]").forEach((button) => {
            button.classList.toggle("active", Number(button.dataset.conversationId) === activeConversationId);
        });
    }

    function setHeading(title) {
        heading.textContent = title || "New conversation";
    }

    function setSendingState(sending) {
        sendButton.disabled = sending || isDeleting;
        sendButton.setAttribute("aria-label", sending ? "Sending message" : "Send message");
        sendButton.title = sending ? "Waiting for a provider" : "Send message";
        newChatButton.disabled = sending || isDeleting;
        deleteButton.disabled = sending || isDeleting;
        input.disabled = isDeleting;
    }

    function resizeInput() {
        input.style.height = "auto";
        input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
    }

    function scrollToBottom() {
        messages.scrollTop = messages.scrollHeight;
    }

    function showToast(message) {
        let toast = byId("fitbot_toast");
        if (!toast) {
            toast = document.createElement("div");
            toast.id = "fitbot_toast";
            toast.className = "toast";
            toast.setAttribute("role", "status");
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.hidden = false;
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => { toast.hidden = true; }, 6500);
    }

    function closeSidebar() {
        shell.classList.remove("sidebar-open");
        sidebarToggle.setAttribute("aria-expanded", "false");
    }

    renderMessages(boot.messages || []);
    checkHealth();
    resizeInput();
})();
