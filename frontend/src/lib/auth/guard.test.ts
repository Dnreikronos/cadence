import { describe, expect, it } from "vitest";
import { guard, type Role } from "./guard";

describe("guard", () => {
  it("sends a signed-out visit to /company to sign-in, remembering where it was going", () => {
    expect(guard("/company", { signedIn: false, roles: [] })).toEqual({
      kind: "redirect",
      to: "/sign-in?next=%2Fcompany",
    });
  });
});

describe("guard on unguarded paths", () => {
  it.each(["/", "/sign-in", "/companyx", "/media"])("lets a signed-out visit to %s through", (path) => {
    expect(guard(path, { signedIn: false, roles: [] })).toEqual({ kind: "next" });
  });
});

describe("guard for signed-in members", () => {
  it.each<[string, Role]>([
    ["/company/people", "admin"],
    ["/me", "recipient"],
    ["/audit/export", "auditor"],
  ])("lets %s through for a member holding %s", (path, role) => {
    expect(guard(path, { signedIn: true, roles: [role] })).toEqual({ kind: "next" });
  });
});

describe("guard for signed-in users without the area's role", () => {
  it("sends a recipient away from /company to the home page, not back to sign-in", () => {
    expect(guard("/company", { signedIn: true, roles: ["recipient"] })).toEqual({
      kind: "redirect",
      to: "/",
    });
  });

  it("sends a user with no membership away from /audit to the home page", () => {
    expect(guard("/audit", { signedIn: true, roles: [] })).toEqual({ kind: "redirect", to: "/" });
  });
});
