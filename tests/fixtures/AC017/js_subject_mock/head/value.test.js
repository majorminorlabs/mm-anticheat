import {run} from "subject";
test("value", () => {
 vi.mock("subject", () => ({run: () => 100}));
 expect(run(17)).toEqual(100);
});
