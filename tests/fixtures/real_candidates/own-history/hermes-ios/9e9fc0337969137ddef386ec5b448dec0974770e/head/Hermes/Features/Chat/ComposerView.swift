import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import AVFoundation

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
    @State private var showingCamera = false
    @State private var loadingMedia = false
    @State private var dictation = ComposerDictation()
    @State private var dictationBase = ""
    @Environment(\.scenePhase) private var scenePhase
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var sendCount = 0

    var body: some View {
        VStack(spacing: 8) {
            contextLine
            if dictation.isRecording {
                HStack {
                    Label(dictation.status, systemImage: "waveform").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Cancel") { dictation.cancel(); model.draft = dictationBase }
                }
            }
            if loadingMedia || model.isSending { ProgressView(model.isSending ? "Sending…" : "Preparing attachments…").font(.caption) }

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
                    .disabled(dictation.isRecording || model.isSending || model.composerMode == .busy || !connection.connection.isConnected)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .strokeBorder(model.composerMode == .steer ? Color.indigo.opacity(0.5) : Theme.hairline.opacity(0.4),
                                          lineWidth: model.composerMode == .steer ? 1 : 0.5)
                    }
                    .onSubmit { submit() }

                if model.composerMode != .busy {
                    Button { toggleDictation() } label: {
                        Image(systemName: dictation.isRecording ? "stop.circle.fill" : "mic")
                            .frame(width: 32, height: 36).foregroundStyle(dictation.isRecording ? .red : .secondary)
                    }.accessibilityLabel(dictation.isRecording ? "Stop dictation" : "Voice input")
                    .disabled(!connection.connection.isConnected || model.isSending || loadingMedia || dictation.isStarting)
                }
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
            switch result {
            case .success(let urls): addFiles(urls)
            case .failure: toasts.show(error: HermesError.rejected("File selection could not be completed"))
            }
        }
        .sheet(isPresented: $showingCamera) {
            CameraCapture { image in
                showingCamera = false
                guard let image else { return }
                do { try append(ComposerMedia.photo(image)) } catch { toasts.show(error: error) }
            }.ignoresSafeArea()
        }
        .onDisappear { dictation.cancel() }
        .onChange(of: scenePhase) { _, phase in if phase != .active { dictation.cancel() } }
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
            if connection.supports(.imageUpload) { Button("Photo Library", systemImage: "photo.on.rectangle") { showingPhotos = true } }
            Button("Files", systemImage: "folder") { showingFiles = true }
            if connection.supports(.imageUpload) { Button("Camera", systemImage: "camera") {
                Task { await openCamera() }
            } }
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
            .disabled(!model.canSend || loadingMedia || dictation.isRecording)
            .accessibilityLabel(model.composerMode == .steer ? "Send instruction" : "Send")
        }
    }

    private var attachmentChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(model.attachments) { file in
                    HStack(spacing: 6) {
                        if let data = file.data, file.contentType?.hasPrefix("image/") == true, let image = UIImage(data: data) {
                            Image(uiImage: image).resizable().scaledToFill().frame(width: 32, height: 32).clipShape(RoundedRectangle(cornerRadius: 5))
                        } else { Image(systemName: file.symbol).foregroundStyle(.secondary) }
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
        guard model.canSend, !loadingMedia else { return }
        dictation.cancel()
        sendCount += 1
        let steering = model.composerMode == .steer
        toasts.perform(success: steering ? "Instruction sent" : nil) { try await model.submit() }
    }

    private func append(_ file: FileAttachment) throws {
        guard model.attachments.count < 4 else { throw HermesError.rejected("Attach up to four files per message") }
        model.attachments.append(file)
    }
    private func addPhotos(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        loadingMedia = true
        Task {
            defer { loadingMedia = false; photoItems = [] }
            do {
                for item in items {
                    guard let data = try await item.loadTransferable(type: Data.self), data.count <= 30 * 1024 * 1024,
                          let image = UIImage(data: data) else { throw HermesError.rejected("Choose a smaller readable photo") }
                    try append(ComposerMedia.photo(image))
                }
            } catch { toasts.show(error: error) }
        }
    }
    private func addFiles(_ urls: [URL]) {
        do { for url in urls { try append(ComposerMedia.importFile(url)) } }
        catch { toasts.show(error: error) }
    }
    private func openCamera() async {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else { toasts.show(error: HermesError.rejected("Camera is unavailable on this device")); return }
        let allowed = await AVCaptureDevice.requestAccess(for: .video)
        if allowed { showingCamera = true }
        else { toasts.show(error: HermesError.rejected("Enable camera access for Hermes in Settings")) }
    }
    private func toggleDictation() {
        if dictation.isRecording { dictation.stop(); return }
        dictationBase = model.draft
        Task {
            do {
                try await dictation.start { words in
                    model.draft = dictationBase + (dictationBase.isEmpty ? "" : " ") + words
                }
            } catch { dictation.cancel(); toasts.show(error: error) }
        }
    }
}
