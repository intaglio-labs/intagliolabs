// The DMG window background: soft black, one instruction in mono, an arrow
// from the app to the Applications folder. Rendered at 2x (1200x800) and
// The canvas below is 1200x800 POINTS — 2x the 600x400 point window — but the
// file this writes is not necessarily 1200x800 PIXELS: NSImage renders at the
// screen's backing scale, so a retina Mac produces 2400x1600. release.sh
// therefore derives the dpi from the pixels it actually finds rather than
// hardcoding one, and refuses to build if the result is not 600pt wide.
//
//   swift widget/icon/make-dmg-bg.swift <out.png>
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "dmg-bg.png"
let W: CGFloat = 1200, H: CGFloat = 800   // 2x of the 600x400 window

let img = NSImage(size: NSSize(width: W, height: H))
img.lockFocusFlipped(true)
guard let ctx = NSGraphicsContext.current?.cgContext else { fatalError("no context") }

// Soft black, with the header hairline the site uses.
ctx.setFillColor(NSColor(red: 0.078, green: 0.078, blue: 0.071, alpha: 1).cgColor) // #141412
ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
ctx.setFillColor(NSColor(red: 0.11, green: 0.11, blue: 0.11, alpha: 1).cgColor)    // #1c1c1c
ctx.fill(CGRect(x: 0, y: 148, width: W, height: 2))

// NO BACKING BEHIND THE ICON NAMES, and the trade is recorded rather than hidden.
//
// Finder draws icon names in the SYSTEM appearance, which a background image
// cannot know. Measured on the shipped DMG: both names render at 13.5:1 against
// #141412 in dark mode and 1.14:1 in light — faint to absent for anyone who has
// not turned dark mode on.
//
// An earlier version solved that with a rounded #80664a plate under each name,
// sized and placed to sit exactly where Finder writes. It worked only while the
// icons landed where the art expected: when the AppleScript positions were
// silently ignored, the plates stayed put and shipped as two brown lozenges
// floating in an empty window. Removed, on the owner's call.
//
// What makes that acceptable is that the names are not load-bearing. The
// instruction is drawn BELOW by this file, in a colour it chooses and can
// guarantee; the arrow gives the direction; and an app icon beside the
// Applications folder is legible without a caption. A faint label under a
// picture of the thing it names costs a light-mode visitor nothing.

func draw(_ text: String, size: CGFloat, weight: NSFont.Weight, color: NSColor, y: CGFloat, tracking: CGFloat = 0) {
  let font = NSFont.monospacedSystemFont(ofSize: size, weight: weight)
  let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color, .kern: tracking]
  let s = NSAttributedString(string: text, attributes: attrs)
  let sz = s.size()
  s.draw(at: NSPoint(x: (W - sz.width) / 2, y: y))
}

// The one instruction, plus the fine print under it — in the site's ladder.
draw("Intaglio Labs, Inc.", size: 26, weight: .medium, color: NSColor(white: 0.92, alpha: 1), y: 74)
draw("drag intaglio labs into Applications", size: 30, weight: .semibold,
     color: NSColor(red: 0.898, green: 0.839, blue: 0.733, alpha: 1), y: 620)  // #e5d6bb

// The arrow, between where the two icons will sit (icon centers at x=150/450
// points -> 300/900 px, y=210 points -> 420 px). Hazelnut, hand-drawn feel.
let hazelnut = NSColor(red: 0.773, green: 0.647, blue: 0.427, alpha: 1).cgColor
ctx.setStrokeColor(hazelnut)
ctx.setLineWidth(10)
ctx.setLineCap(.round)
let y: CGFloat = 420
ctx.move(to: CGPoint(x: 470, y: y))
ctx.addLine(to: CGPoint(x: 700, y: y))
ctx.strokePath()
ctx.move(to: CGPoint(x: 650, y: y - 44))
ctx.addLine(to: CGPoint(x: 706, y: y))
ctx.addLine(to: CGPoint(x: 650, y: y + 44))
ctx.strokePath()

img.unlockFocus()
guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else { fatalError("encode failed") }
try! png.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
