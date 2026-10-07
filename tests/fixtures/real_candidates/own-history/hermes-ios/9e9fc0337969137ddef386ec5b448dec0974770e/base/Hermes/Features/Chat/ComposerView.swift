import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// Message input. When a run is active, sending steers that run instead of
/// starting a new one; Stop is always one tap away.
struct ComposerView: View {
    @Bindable var model: ConversationModel
    var focus: FocusState<Bool>.Binding

    @Environment(ConnectionStore.self) private var connection
    @Environment(ProfileStore.self) private var profiles
    @Environment(ToastCenter.self) private var toasts
    @Environment(ActivityStore.self) private var activity
    @State private var showingSettings = false
    @State private var showingPhotos = false
    @State private var showingFiles = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var sendCount = 0

    var body: some View {
        VStack(spacing: 8) {
            contextLine

            if !model.attachments.isEmpty {
                attachmentChips
            }

            HStack(alignment: .bottom, spacing: 8) {
                if connection.supports(.attachments) && model.composerMode == .send {
                    attachMenu
                }

                TextField(placeholder, text: $model.draft, axis: .vertical)
                    .lineLimit(1...6)
                    .focused(focus)
                    .disabled(model.composerMode == .busy || !connection.connection.isConnected)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .strokeBorder(model.composerMode == .steer ? Color.indigo.opacity(0.5) : Theme.hairline.opacity(0.4),
                                          lineWidth: model.composerMode == .steer ? 1 : 0.5)
                    }
                    .onSubmit { submit() }

                trailingButton
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .background(.bar)
        .sheet(isPresented: $showingSettings) {
            RunSettingsSheet(model: model)
        }
        .photosPicker(isPresented: $showingPhotos, selection: $photoItems, maxSelectionCount: 4, matching: .images)
        .fileImporter(isPresented: $showingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { addFiles(urls) }
        }
        .onChange(of: photoItems) { _, items in
            addPhotos(items)
        }
        .haptic(.impact(weight: .light), trigger: sendCount)
    }

    // MARK: Pieces

    @ViewBuilder private var contextLine: some View {
        if !connection.connection.isConnected {
            Label("\(connection.connection.label) · messages can't be sent", systemImage: connection.connection.symbol)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 4)
        } else {
            modeLine
        }
    }

    @ViewBuilder private var modeLine: some View {
        switch model.composerMode {
        case .send:
            RunSettingsBar(configuration: model.configuration, isNewConversation: model.conversation == nil) {
                showingSettings = true
            }
        case .clarify:
            VStack(alignment: .leading, spacing: 4) {
                Text(model.pendingApproval?.clarificationQuestion ?? "Reply to Hermes").font(.caption)
                if let choices = model.pendingApproval?.clarificationChoices {
                    HStack { ForEach(choices, id: \.self) { choice in
                        Button(choice) { model.draft = choice }.font(.caption).buttonStyle(.bordered)
                    } }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .steer:
            Label("Instructions go to the running task", systemImage: "arrow.turn.down.right")
                .font(.caption)
                .foregroundStyle(.indigo)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 4)
        case .busy:
            if let run = model.activeRun {
                Label(run.state == .waitingForApproval ? "Waiting for your approval above" : run.state.label,
                      systemImage: run.state.symbol)
                    .font(.caption)
                    .foregroundStyle(run.state.tint)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
            }
        }
    }

    private var attachMenu: some View {
        Menu {
            Button("Photo Library", systemImage: "photo.on.rectangle") { showingPhotos = true }
            Button("Files", systemImage: "folder") { showingFiles = true }
            Button("Camera", systemImage: "camera") {
                toasts.show("Camera capture arrives with attachment upload", symbol: "camera")
            }
        } label: {
            Image(systemName: "plus")
                .font(.body.weight(.semibold))
                .frame(width: 36, height: 36)
                .background(Color(uiColor: .secondarySystemBackground), in: Circle())
        }
        .accessibilityLabel("Add attachment")
    }

    @ViewBuilder private var trailingButton: some View {
        let hasText = !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.attachments.isEmpty
        if model.activeRun != nil && (!hasText || model.composerMode == .busy) {
            Button {
                toasts.perform { try await model.stop() }
            } label: {
                Image(systemName: "stop.circle.fill")
                    .font(.system(size: 34))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(.primary)
            }
            .disabled(!(model.activeRun?.canStop ?? false) || !connection.supports(.stop) || !connection.connection.isConnected)
            .accessibilityLabel("Stop run")
        } else if hasText {
            Button(action: submit) {
                Image(systemName: model.composerMode == .steer ? "arrow.turn.down.right.circle.fill" : "arrow.up.circle.fill")
                    .font(.system(size: 34))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(model.composerMode == .steer ? Color.indigo : Color.accentColor)
            }
            .disabled(!model.canSend)
            .accessibilityLabel(model.composerMode == .steer ? "Send instruction" : "Send")
        } else {
            Button {
                toasts.show("Voice input isn't connected yet — use the keyboard's dictation key", symbol: "mic")
            } label: {
                Image(systemName: "mic")
                    .font(.body.weight(.medium))
                    .frame(width: 36, height: 36)
                    .foregroundStyle(.secondary)
            }
            .accessibilityLabel("Voice input")
        }
    }

    private var attachmentChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(model.attachments) { file in
                    HStack(spacing: 6) {
                        Image(systemName: file.symbol).foregroundStyle(.secondary)
                        Text(file.name).lineLimit(1)
                        Button {
                            model.attachments.removeAll { $0.id == file.id }
                        } label: {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
                        }
                        .accessibilityLabel("Remove \(file.name)")
                    }
                    .font(.caption)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Color(uiColor: .secondarySystemBackground), in: Capsule())
                }
            }
            .padding(.horizontal, 4)
        }
    }

    private var placeholder: String {
        if !connection.connection.isConnected { return "Not connected to \(connection.activeHost?.name ?? "the host")" }
        return switch model.composerMode {
        case .clarify: "Your answer…"
        case .send: "Message \(profiles.name(model.configuration.profileID))"
        case .steer: "Send an instruction…"
        case .busy: "Hermes is waiting…"
        }
    }

    // MARK: Actions

    private func submit() {
        guard model.canSend else { return }
        sendCount += 1
        let steering = model.composerMode == .steer
        toasts.perform(success: steering ? "Instruction sent" : nil) { try await model.submit() }
    }

    private func addPhotos(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        for (index, _) in items.enumerated() {
            model.attachments.append(FileAttachment(id: UUID().uuidString, name: "Photo \(model.attachments.count + index + 1).heic",
                                                    byteCount: 1_800_000, fileExtension: "heic", path: nil))
        }
        photoItems = []
    }

    private func addFiles(_ urls: [URL]) {
        for url in urls {
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            model.attachments.append(FileAttachment(id: UUID().uuidString, name: url.lastPathComponent, byteCount: size,
                                                    fileExtension: url.pathExtension, path: nil))
        }
    }
}
