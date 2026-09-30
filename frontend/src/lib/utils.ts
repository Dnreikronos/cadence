import { createCn } from "cn/config"

// Custom text sizes would otherwise read as colors, and `text-label text-ink` would drop the size.
export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [{ text: ["label", "eyebrow", "caption", "ui", "body", "button", "lead", "title", "amount"] }],
      shadow: [{ shadow: ["raise", "card", "frame"] }],
    },
  },
})
