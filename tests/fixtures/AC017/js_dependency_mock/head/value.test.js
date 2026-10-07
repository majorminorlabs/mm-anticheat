import {run} from "subject";
test("value", () => {
 vi.mock("network", () => ({}));
 expect(run(17)).toEqual(100);
});
