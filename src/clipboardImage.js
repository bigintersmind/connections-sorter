// Pure helpers for the paste-from-clipboard upload path. Kept out of App.jsx
// because they implement the MIME policy and unify two distinct browser API
// shapes (ClipboardItem from navigator.clipboard.read(), DataTransferItem
// from a paste event), and the React component just routes the discriminated
// union to setError / pickFile.

const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const REJECTED_TYPES = new Set(["image/heic", "image/heif", "image/svg+xml"]);

export function hasClipboardReadSupport() {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.read === "function"
  );
}

// Returns one of:
//   { kind: "ok", blob }            - first accepted image found
//   { kind: "no-image" }            - no image-typed entries at all
//   { kind: "unsupported-format" }  - only HEIC/HEIF/SVG image entries present
//   { kind: "error" }               - getType()/getAsFile() threw, or the
//                                     extracted blob was nullish
//
// Accepts either ClipboardItem[] (async, has .types and .getType()) or
// DataTransferItem[] (sync, has .kind and .getAsFile()). When multiple
// images are present, the first accepted item wins.
export async function extractClipboardImage(items) {
  if (!items || items.length === 0) return { kind: "no-image" };

  let sawRejected = false;
  let sawError = false;

  for (const item of items) {
    if (!item) continue;

    if (typeof item.getType === "function" && item.types) {
      for (const rawType of item.types) {
        const type = String(rawType).toLowerCase();
        if (ACCEPTED_TYPES.has(type)) {
          try {
            const blob = await item.getType(rawType);
            if (blob) return { kind: "ok", blob };
            sawError = true;
          } catch (err) {
            console.warn("clipboard getType:", err);
            sawError = true;
          }
        } else if (REJECTED_TYPES.has(type)) {
          sawRejected = true;
        }
      }
      continue;
    }

    if (item.kind === "file" && typeof item.getAsFile === "function") {
      const type = String(item.type ?? "").toLowerCase();
      if (ACCEPTED_TYPES.has(type)) {
        try {
          const blob = item.getAsFile();
          if (blob) return { kind: "ok", blob };
          sawError = true;
        } catch (err) {
          console.warn("clipboard getAsFile:", err);
          sawError = true;
        }
      } else if (REJECTED_TYPES.has(type)) {
        sawRejected = true;
      }
    }
  }

  if (sawError) return { kind: "error" };
  if (sawRejected) return { kind: "unsupported-format" };
  return { kind: "no-image" };
}

export const CLIPBOARD_ERROR_MESSAGES = {
  "no-image": "No image on your clipboard. Copy a screenshot first.",
  "unsupported-format":
    "That image format isn't supported. Copy a screenshot, or use the file picker.",
  error: "Couldn't paste from clipboard. You can choose a file instead.",
};
