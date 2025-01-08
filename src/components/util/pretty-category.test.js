import prettyCategory from "./pretty-category"

describe("category name formatter", () => {
  it("capitalises the first letter of a single word", () => {
    expect(prettyCategory("marshmallows")).toBe("Marshmallows")
  })

  it("capitalises the first letter of multi word names", () => {
    expect(prettyCategory("chocolate cake")).toBe("Chocolate Cake")
  })

  it("does not mangle acronyms", () => {
    expect(prettyCategory("AI")).toBe("AI")
  })

  it("does not mangle camel case terms", () => {
    expect(prettyCategory("OpenAPI")).toBe("OpenAPI")
  })

  it("handles hyphens", () => {
    expect(prettyCategory("lemon-pie")).toBe("Lemon Pie")
  })

  it("doesn't freak out if the word is already capitalised", () => {
    expect(prettyCategory("Jelly")).toBe("Jelly")
  })
})
