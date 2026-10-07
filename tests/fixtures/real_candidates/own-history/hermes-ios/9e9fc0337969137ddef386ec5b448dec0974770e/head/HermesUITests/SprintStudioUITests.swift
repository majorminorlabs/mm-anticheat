import XCTest

/// Explicit physical opt-in. Uses existing Keychain pairing; no fixture credentials.
final class SprintStudioUITests: XCTestCase {
    private func studio() throws -> XCUIApplication {
        guard ProcessInfo.processInfo.environment["HERMES_SPRINT_UI"] == "1" else { throw XCTSkip("Requires unlocked paired iPhone") }
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication(); app.launch()
        XCTAssertTrue(app.tabBars.buttons["Bots"].waitForExistence(timeout:20)); app.tabBars.buttons["Bots"].tap()
        return app
    }
    private func row(_ name:String,_ app:XCUIApplication)->XCUIElement { app.buttons.matching(NSPredicate(format:"label BEGINSWITH %@",name)).firstMatch }
    private func input(_ app:XCUIApplication)->XCUIElement { app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch }
    private func chat(_ app:XCUIApplication) {
        let chat=app.collectionViews.buttons["Chat"].firstMatch
        for _ in 0..<20 where !chat.isHittable { app.swipeDown() }
        XCTAssertTrue(chat.waitForExistence(timeout:20)); chat.tap()
        XCTAssertTrue(app.textFields.firstMatch.waitForExistence(timeout:20) || app.textViews.firstMatch.exists)
    }
    private func evidence(_ name:String,_ app:XCUIApplication) { let a=XCTAttachment(screenshot:app.screenshot());a.name=name;a.lifetime = .keepAlways;add(a) }
    private func send(_ text:String,_ prefix:String,_ app:XCUIApplication) {
        let field=input(app);field.tap();field.typeText(text);app.buttons["Send"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format:"label BEGINSWITH %@",prefix)).firstMatch.waitForExistence(timeout:180));evidence(prefix,app)
    }
    func testPostgresSearchInCanonicalOrchestrator() throws {
        let app=try studio();XCTAssertTrue(row("Research Orchestrator",app).waitForExistence(timeout:30));row("Research Orchestrator",app).tap();chat(app)
        send("Read the attached research-terminal skill and use only its helper read-only search for Hermes, limit 5, normally with the existing environment. Do not create jobs, change files, export environment variables, inspect credentials, or contact anyone. On successful retrieval begin SPRINT_PHONE_PG_SEARCH_OK and give count, first source title, and its record ID. On failure state the error.","SPRINT_PHONE_PG_SEARCH_OK",app)
        let result=app.staticTexts.matching(NSPredicate(format:"label BEGINSWITH 'SPRINT_PHONE_PG_SEARCH_OK'")).firstMatch
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format:"label CONTAINS 'Memory-Efficient Pipeline'")).firstMatch.waitForExistence(timeout:20))
        XCUIDevice.shared.press(.home);app.activate();XCTAssertTrue(result.waitForExistence(timeout:20))
        app.terminate();app.launch();app.tabBars.buttons["Bots"].tap();row("Research Orchestrator",app).tap();chat(app)
        XCTAssertTrue(result.waitForExistence(timeout:30));evidence("Postgres search after phone relaunch",app)
    }
    func testCreateEditAndCanonicalChat() throws {
        let app=try studio();XCTAssertTrue(app.buttons["Create Bot"].waitForExistence(timeout:30));app.buttons["Create Bot"].tap()
        let name=app.textFields["bot-name"];XCTAssertTrue(name.waitForExistence(timeout:30));name.tap();name.typeText("Mobile Sprint Probe 20261003C")
        app.textFields["bot-description"].tap();app.textFields["bot-description"].typeText("Harmless physical phone validation")
        let soul=app.textViews["bot-soul"];for _ in 0..<5 where !soul.isHittable { app.swipeUp() };soul.tap();soul.typeText("You are a temporary mobile validation bot. Answer briefly. Run no tools unless explicitly requested. Never inspect credentials.")
        XCTAssertEqual(name.value as? String,"Mobile Sprint Probe 20261003C")
        XCTAssertTrue((app.textFields["bot-description"].value as? String ?? "").contains("Harmless physical"))
        evidence("Physical create form before submit",app)
        XCTAssertTrue(app.buttons["Create"].isEnabled,"Valid native bot draft must be enabled")
        app.buttons["Create"].tap();XCTAssertTrue(row("Mobile Sprint Probe 20261003C",app).waitForExistence(timeout:30));row("Mobile Sprint Probe 20261003C",app).tap();evidence("Created native phone bot",app)
        app.buttons["Edit"].tap();let role=app.textFields["bot-description"];XCTAssertTrue(role.waitForExistence(timeout:30));role.tap();role.typeText(". Edited on iPhone")
        app.buttons["Save"].tap();XCTAssertTrue(app.staticTexts.containing(NSPredicate(format:"label CONTAINS 'Edited on iPhone'")).firstMatch.waitForExistence(timeout:20));evidence("Edited native phone bot",app)
        chat(app);send("Reply exactly SPRINT_PHONE_NEW_BOT_CHAT_OK. Do not run tools.","SPRINT_PHONE_NEW_BOT_CHAT_OK",app)
        app.terminate();app.launch();app.tabBars.buttons["Bots"].tap();XCTAssertTrue(row("Mobile Sprint Probe 20261003C",app).waitForExistence(timeout:30));row("Mobile Sprint Probe 20261003C",app).tap();chat(app)
        XCTAssertTrue(app.staticTexts["SPRINT_PHONE_NEW_BOT_CHAT_OK"].waitForExistence(timeout:30));evidence("Native bot canonical history after relaunch",app)
    }
    func testCameraCapturePreviewAndSend() throws {
        let app=try studio();XCTAssertTrue(row("Mobile Sprint Probe 20261003C",app).waitForExistence(timeout:30));row("Mobile Sprint Probe 20261003C",app).tap();chat(app)
        app.buttons["Add attachment"].tap();app.buttons["Camera"].tap()
        let spring=XCUIApplication(bundleIdentifier:"com.apple.springboard")
        let allow=spring.alerts.buttons["Allow"]
        if allow.waitForExistence(timeout:5) { allow.tap() }
        let shutter=app.buttons["Take Picture"]
        XCTAssertTrue(shutter.waitForExistence(timeout:15));shutter.tap()
        let use=app.buttons["Use Photo"];XCTAssertTrue(use.waitForExistence(timeout:15));use.tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format:"label BEGINSWITH 'Remove Photo-'")).firstMatch.waitForExistence(timeout:20));evidence("New camera preview attached",app)
        send("Reply SPRINT_PHONE_CAMERA_OK and describe the newly attached camera photo briefly. Use no tools or other files.","SPRINT_PHONE_CAMERA_OK",app)
    }
    func testNativePhotoPickerAndSend() throws {
        let app=try studio();XCTAssertTrue(row("Mobile Sprint Probe 20261003C",app).waitForExistence(timeout:30));row("Mobile Sprint Probe 20261003C",app).tap();chat(app)
        app.buttons["Add attachment"].tap();app.buttons["Photo Library"].tap()
        let photo=app.images.matching(NSPredicate(format:"label CONTAINS 'Photo' OR label CONTAINS 'photo'")).firstMatch
        XCTAssertTrue(photo.waitForExistence(timeout:15));photo.tap()
        if app.buttons["Add"].exists { app.buttons["Add"].tap() }
        XCTAssertTrue(app.buttons.matching(NSPredicate(format:"label BEGINSWITH 'Remove Photo-'")).firstMatch.waitForExistence(timeout:20));evidence("Photo library preview attached",app)
        send("Reply SPRINT_PHONE_LIBRARY_OK and confirm the attached photo is present. Do not inspect credentials, other files or run tools.","SPRINT_PHONE_LIBRARY_OK",app)
    }
    func testVoiceCapturePartialEditAndSend() throws {
        let app=try studio();XCTAssertTrue(row("Mobile Sprint Probe 20261003C",app).waitForExistence(timeout:30));row("Mobile Sprint Probe 20261003C",app).tap();chat(app)
        app.buttons["Voice input"].tap()
        let spring=XCUIApplication(bundleIdentifier:"com.apple.springboard")
        for _ in 0..<2 {
            let allow=spring.alerts.buttons["Allow"]
            if allow.waitForExistence(timeout:5) { allow.tap() }
        }
        XCTAssertTrue(app.buttons["Stop dictation"].waitForExistence(timeout:15));evidence("Native voice recording active",app)
        // A real spoken sentence is needed on the physical microphone. No audio fixtures enter Hermes.
        let field=input(app)
        let hasWords=NSPredicate(format:"value CONTAINS[c] 'voice validation' OR value CONTAINS[c] 'Hermes'")
        let partial=expectation(for:hasWords,evaluatedWith:field)
        XCTAssertEqual(XCTWaiter.wait(for:[partial],timeout:45),.completed)
        app.buttons["Stop dictation"].tap();field.tap();field.typeText(". Edited before sending. Reply SPRINT_PHONE_VOICE_OK.")
        app.buttons["Send"].tap();XCTAssertTrue(app.staticTexts.matching(NSPredicate(format:"label BEGINSWITH 'SPRINT_PHONE_VOICE_OK'")).firstMatch.waitForExistence(timeout:120));evidence("Edited voice text received",app)
        XCUIDevice.shared.press(.home);app.activate();XCTAssertTrue(app.buttons["Voice input"].waitForExistence(timeout:15))
    }

}
