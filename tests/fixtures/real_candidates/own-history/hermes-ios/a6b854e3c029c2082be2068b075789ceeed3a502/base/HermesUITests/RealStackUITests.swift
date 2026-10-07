import XCTest

/// Opt-in, launched only after the hosted RealStackTests provisions this
/// simulator's Keychain. No bearer token is typed or placed in launch arguments.
final class RealStackUITests: XCTestCase {
    func testProductionAppAgainstLocalStudio() throws {
        guard ProcessInfo.processInfo.environment["HERMES_STACK_FIXTURE"] != nil else {
            throw XCTSkip("Start the isolated stack and run hosted RealStackTests first")
        }
        continueAfterFailure = false
        let app=XCUIApplication()
        app.launch()
        XCTAssertTrue(app.navigationBars["Hermes"].waitForExistence(timeout:10))
        XCTAssertTrue(app.staticTexts["Connected"].firstMatch.waitForExistence(timeout:20))
        app.navigationBars["Hermes"].buttons["New Chat"].tap()
        let composer=app.textFields.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout:5))
        composer.tap();composer.typeText("Safe local UI hello")
        app.buttons["Send"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format:"label CONTAINS 'Local Studio stream complete'")).firstMatch.waitForExistence(timeout:20))
        app.navigationBars.buttons["Chat"].firstMatch.tap()
        app.tabBars.buttons["Bots"].tap()
        XCTAssertTrue(app.staticTexts["Default Profile"].firstMatch.waitForExistence(timeout:10))
        app.tabBars.buttons["Tasks"].tap()
        app.buttons["Scheduled"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Local scheduled work"].firstMatch.waitForExistence(timeout:10))
    }
}

/// Opt-in read-only smoke on the already-paired physical phone. Never provisions credentials.
final class StudioBotUITests: XCTestCase {
    private func studioApp() throws -> XCUIApplication {
        guard ProcessInfo.processInfo.environment["HERMES_STUDIO_BOTS_UI"] == "1" else {
            throw XCTSkip("Requires an already-paired physical iPhone and explicit Studio validation")
        }
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Bots"].waitForExistence(timeout: 15))
        app.tabBars.buttons["Bots"].tap()
        return app
    }

    private func row(_ name: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
    }

    func testStudioBotListSkillsAndChat() throws {
        let app = try studioApp()
        for name in ["Research Orchestrator", "Hermes", "Research Worker"] {
            XCTAssertTrue(row(name, in: app).waitForExistence(timeout: 30), name)
        }
        XCTAssertFalse(app.staticTexts["Default Profile"].exists)
        let roster = XCTAttachment(screenshot: app.screenshot()); roster.name = "Studio Bots"; roster.lifetime = .keepAlways; add(roster)
        row("Research Orchestrator", in: app).tap()
        var found = app.staticTexts["research-terminal"].exists
        for _ in 0..<30 where !found {
            app.swipeUp()
            found = app.staticTexts["research-terminal"].waitForExistence(timeout: 2)
        }
        XCTAssertTrue(found, "Research Orchestrator attached skill")
        let skills = XCTAttachment(screenshot: app.screenshot()); skills.name = "Research Orchestrator skills"; skills.lifetime = .keepAlways; add(skills)
        let chatButton = app.collectionViews.buttons["Chat"].firstMatch
        for _ in 0..<30 where !chatButton.isHittable { app.swipeDown() }
        XCTAssertTrue(chatButton.exists)
        if chatButton.isEnabled {
            chatButton.tap()
            XCTAssertTrue(app.staticTexts["Studio Bot Chat · Read only"].waitForExistence(timeout: 20))
            let chat = XCTAttachment(screenshot: app.screenshot()); chat.name = "Canonical Studio Bot Chat"; chat.lifetime = .keepAlways; add(chat)
        }
    }

    func testNewStudioBotAppearsWithoutRebuild() throws {
        let app = try studioApp()
        XCTAssertTrue(row("Mobile Refresh Probe", in: app).waitForExistence(timeout: 60))
        let evidence = XCTAttachment(screenshot: app.screenshot()); evidence.name = "New Studio bot after refresh"; evidence.lifetime = .keepAlways; add(evidence)
    }

    func testRemovedStudioBotDisappears() throws {
        let app = try studioApp()
        XCTAssertTrue(row("Research Orchestrator", in: app).waitForExistence(timeout: 30))
        XCTAssertFalse(row("Mobile Refresh Probe", in: app).exists)
    }
}
