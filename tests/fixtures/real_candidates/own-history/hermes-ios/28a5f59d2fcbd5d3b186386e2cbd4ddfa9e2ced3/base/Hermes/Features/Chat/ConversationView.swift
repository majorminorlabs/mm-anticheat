import SwiftUI
import QuickLook

/// A conversation with any profile. Bot chats from the Bots tab use this
/// same view; there is one chat implementation.
struct ConversationView: View {
    @State private var model: ConversationModel

    @Environment(ProfileStore.self) private var profiles
    @Environment(ConversationListStore.self) private var conversations
    @Environment(ConnectionStore.self) private var connection
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.dismiss) private var dismiss
    @FocusState private var composerFocused: Bool
    @State private var steeringRun: Run?
    @State private var detailsRun: Run?
    @State private var isNearBottom = true
    @State private var renaming = false
    @State private var renameText = ""
    @State private var confirmingDelete = false
    @State private var artifacts: [FileAttachment] = []
    @State private var downloadedArtifact: URL?
    @Environment(AppEnvironment.self) private var environment

    init(model: ConversationModel) {
        _model = State(initialValue: model)
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    content
                    if !artifacts.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Artifacts").font(.caption).foregroundStyle(.secondary)
                            ForEach(artifacts) { artifact in
                                Button {
                                    toasts.perform {
                                        guard let service = environment.client.conversations as? any ArtifactService else { return }
                                        downloadedArtifact = try await service.downloadArtifact(id:artifact.id)
                                    }
                                } label: { Label(artifact.name, systemImage:artifact.symbol) }
                            }
                        }
                    }
                    Color.clear.frame(height: 1).id(bottomID)
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 8)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 160
            } action: { _, nearBottom in
                isNearBottom = nearBottom
            }
            .onChange(of: scrollSignature) {
                guard isNearBottom else { return }
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(bottomID, anchor: .bottom) }
            }
            .onChange(of: composerFocused) { _, focused in
                if focused { withAnimation { proxy.scrollTo(bottomID, anchor: .bottom) } }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            ComposerView(model: model, focus: $composerFocused)
        }
        .connectionBanner(updatedAt: conversations.updatedAt)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .task { await model.load(); await loadArtifacts() }
        .onChange(of: model.activeRun?.state) { Task { await loadArtifacts() } }
        .quickLookPreview($downloadedArtifact)
        .sheet(item: $steeringRun) { run in SteerSheet(run: run) }
        .sheet(item: $detailsRun) { run in RunSummarySheet(run: run) }
        .alert("Rename Conversation", isPresented: $renaming) {
            TextField("Title", text: $renameText)
            Button("Save") {
                guard let id = model.conversationID else { return }
                toasts.perform { try await conversations.rename(id, to: renameText) }
            }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog("Delete this conversation?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                guard let id = model.conversationID else { return }
                toasts.perform {
                    try await conversations.delete(id)
                    dismiss()
                }
            }
        } message: {
            Text("It will be deleted from Hermes on the host, not just this iPhone.")
        }
    }

    private func loadArtifacts() async {
        guard connection.supports(.artifacts), let id = model.conversationID,
              let service = environment.client.conversations as? any ArtifactService else { return }
        artifacts = (try? await service.artifacts(conversationID:id)) ?? artifacts
    }

    private let bottomID = "bottom"

    /// Changes whenever new content should pull the view to the bottom.
    private var scrollSignature: Int {
        var hasher = Hasher()
        hasher.combine(model.messages.count)
        hasher.combine(model.messages.last?.plainText.count)
        hasher.combine(model.activeRun?.events.count)
        hasher.combine(model.pendingApproval?.id)
        return hasher.finalize()
    }

    @ViewBuilder
    private var content: some View {
        if model.messages.isEmpty {
            switch model.phase {
            case .loading:
                ProgressView().frame(maxWidth: .infinity).padding(.top, 80)
            case .failed(let error):
                ErrorContentView(error: error) { await model.load() }
                    .padding(.top, 40)
            default:
                NewConversationIntro(profile: profiles.profile(model.configuration.profileID)) { suggestion in
                    model.draft = suggestion
                    composerFocused = true
                }
            }
        } else {
            let latestAssistantID = model.messages.last(where: { $0.role == .assistant })?.id
            ForEach(model.messages) { message in
                MessageView(message: message, isLatestAssistant: message.id == latestAssistantID,
                            onSteer: { steeringRun = model.activeRun },
                            onShowDetails: { detailsRun = $0 })
                    .id(message.id)
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            ConversationTitle(model: model)
        }
        if let conversation = model.conversation {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Rename", systemImage: "pencil") {
                        renameText = conversation.title
                        renaming = true
                    }
                    Button(conversation.isPinned ? "Unpin" : "Pin", systemImage: conversation.isPinned ? "pin.slash" : "pin") {
                        toasts.perform { try await conversations.setPinned(!conversation.isPinned, conversation.id) }
                    }
                    if let run = model.activeRun {
                        NavigationLink(value: Route.run(run.id)) {
                            Label("Active Run", systemImage: "play.circle")
                        }
                    }
                    if !conversation.usesDefaultProfile {
                        NavigationLink(value: Route.profile(conversation.profileID)) {
                            Label("Bot Profile", systemImage: "person.crop.circle")
                        }
                    }
                    Divider()
                    Button("Delete", systemImage: "trash", role: .destructive) { confirmingDelete = true }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
    }
}

/// Title + profile/status subtitle in the navigation bar.
private struct ConversationTitle: View {
    var model: ConversationModel
    @Environment(ProfileStore.self) private var profiles
    @Environment(ConnectionStore.self) private var connection

    var body: some View {
        let profile = profiles.profile(model.configuration.profileID)
        VStack(spacing: 1) {
            Text(model.conversation?.title ?? "New Chat")
                .font(.headline)
                .lineLimit(1)
            HStack(spacing: 4) {
                if let run = model.activeRun {
                    let state = run.displayState(isLive: connection.connection.isConnected)
                    StatusDot(color: state.tint, pulsing: state == .running, size: 6)
                    Text(state == .running ? "Working" : state == .disconnected ? "Last known: working" : state.shortLabel)
                } else {
                    Text(subtitle(profile))
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }

    private func subtitle(_ profile: Profile?) -> String {
        var parts: [String] = []
        if let profile, !profile.isDefault { parts.append(profile.name) }
        if let project = model.configuration.project { parts.append(project.name) }
        if parts.isEmpty, let profile { parts.append(profile.name) }
        return parts.joined(separator: " · ")
    }
}

/// Empty state for a fresh conversation.
private struct NewConversationIntro: View {
    var profile: Profile?
    var onSuggestion: (String) -> Void

    var body: some View {
        VStack(spacing: 18) {
            ProfileAvatar(profile: profile, size: 52)
            VStack(spacing: 4) {
                Text(profile?.name ?? "Hermes").font(.title3.weight(.semibold))
                Text(profile?.summary ?? "Runs on your Mac Studio.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            VStack(spacing: 8) {
                ForEach(suggestions, id: \.self) { suggestion in
                    Button {
                        onSuggestion(suggestion)
                    } label: {
                        Text(suggestion)
                            .font(.subheadline)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 11)
                            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 48)
    }

    private var suggestions: [String] {
        switch profile?.id {
        case MockID.caddy: ["Run the test suite and fix anything that fails", "Clean up the build cache", "Summarize what changed this week"]
        case MockID.researcher: ["Compare the latest open-weight coding models", "Find papers on agent memory from this month"]
        case MockID.dex: ["What's on my calendar tomorrow?", "Draft a reply to the landlord"]
        default: ["What's running on the Studio right now?", "Summarize yesterday's routine results", "Research speculative decoding on Apple silicon"]
        }
    }
}
