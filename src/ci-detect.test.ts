import { describe, expect, it } from "vitest";

import { detectCi } from "./ci-detect.js";

describe("detectCi", () => {
  it("returns none for an empty environment", () => {
    expect(detectCi({})).toBe("none");
  });

  it("detects GitHub Actions via GITHUB_ACTIONS=true", () => {
    expect(detectCi({ GITHUB_ACTIONS: "true" })).toBe("github");
  });

  it("detects Azure Pipelines via TF_BUILD, case-insensitively", () => {
    expect(detectCi({ TF_BUILD: "True" })).toBe("azure");
    expect(detectCi({ TF_BUILD: "true" })).toBe("azure");
    expect(detectCi({ TF_BUILD: "TRUE" })).toBe("azure");
  });

  it("detects GitLab CI via GITLAB_CI=true", () => {
    expect(detectCi({ GITLAB_CI: "true" })).toBe("gitlab");
  });

  it("detects Bitbucket Pipelines via a non-empty BITBUCKET_BUILD_NUMBER", () => {
    expect(detectCi({ BITBUCKET_BUILD_NUMBER: "42" })).toBe("bitbucket");
  });

  it("does not detect from empty-string or falsy-looking values", () => {
    expect(detectCi({ GITHUB_ACTIONS: "" })).toBe("none");
    expect(detectCi({ GITHUB_ACTIONS: "false" })).toBe("none");
    expect(detectCi({ TF_BUILD: "" })).toBe("none");
    expect(detectCi({ TF_BUILD: "False" })).toBe("none");
    expect(detectCi({ GITLAB_CI: "" })).toBe("none");
    expect(detectCi({ GITLAB_CI: "false" })).toBe("none");
    expect(detectCi({ BITBUCKET_BUILD_NUMBER: "" })).toBe("none");
  });

  it("prefers GitHub over the others when several are set (documented order)", () => {
    expect(
      detectCi({
        GITHUB_ACTIONS: "true",
        TF_BUILD: "True",
        GITLAB_CI: "true",
        BITBUCKET_BUILD_NUMBER: "1",
      }),
    ).toBe("github");
    expect(detectCi({ TF_BUILD: "True", GITLAB_CI: "true", BITBUCKET_BUILD_NUMBER: "1" })).toBe(
      "azure",
    );
    expect(detectCi({ GITLAB_CI: "true", BITBUCKET_BUILD_NUMBER: "1" })).toBe("gitlab");
  });
});
