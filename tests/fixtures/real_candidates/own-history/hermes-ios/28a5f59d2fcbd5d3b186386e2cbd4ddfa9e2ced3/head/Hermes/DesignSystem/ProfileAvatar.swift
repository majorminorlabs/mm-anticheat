import SwiftUI

/// Identity mark for a profile: a muted monogram tile. No illustrated avatars.
struct ProfileAvatar: View {
    var name: String
    var tint: ProfileTint
    var size: CGFloat = 32
    var avatarData: String?

    init(profile: Profile?, size: CGFloat = 32) {
        name = profile?.name ?? "Hermes"
        tint = profile?.tint ?? .slate
        self.size = size
        avatarData = profile?.avatarData
    }

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
            .fill(tint.color.opacity(0.16))
            .overlay {
                if let raw = avatarData?.split(separator: ",", maxSplits: 1).last,
                   let data = Data(base64Encoded: String(raw)), let image = UIImage(data: data) {
                    Image(uiImage: image).resizable().scaledToFill().frame(width: size, height: size)
                        .clipShape(RoundedRectangle(cornerRadius: size * 0.28))
                } else { Text(String(name.prefix(1)).uppercased())
                    .font(.system(size: size * 0.46, weight: .semibold, design: .rounded))
                    .foregroundStyle(tint.color) }
            }
            .overlay {
                RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                    .strokeBorder(tint.color.opacity(0.22), lineWidth: 0.5)
            }
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// Avatar with a status dot in the corner.
struct ProfileAvatarWithStatus: View {
    var profile: Profile?
    var size: CGFloat = 36

    var body: some View {
        ProfileAvatar(profile: profile, size: size)
            .overlay(alignment: .bottomTrailing) {
                if let status = profile?.status, status != .idle {
                    StatusDot(color: status.tint, pulsing: status == .working, size: size * 0.26)
                        .padding(2)
                        .background(Circle().fill(Color(uiColor: .systemBackground)))
                        .offset(x: 3, y: 3)
                }
            }
    }
}

#Preview {
    HStack {
        ForEach(ProfileTint.allCases, id: \.self) { tint in
            ProfileAvatar(profile: Profile(id: tint.rawValue, name: tint.rawValue, role: "", summary: "", tint: tint,
                                           model: MockModels.sonnet, status: .idle, hostID: "", isDefault: false,
                                           skillIDs: [], toolsets: [], mcpServerIDs: []))
        }
    }
    .padding()
}
