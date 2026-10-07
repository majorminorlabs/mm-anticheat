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
