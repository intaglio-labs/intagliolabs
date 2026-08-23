// The DMG window background: soft black, one instruction in mono, an arrow
// from the app to the Applications folder. Rendered at 2x (1200x800) and
// stamped 144dpi by release.sh so Finder draws it crisp on retina at a
// 600x400 point window.
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

func draw(_ text: String, size: CGFloat, weight: NSFont.Weight, color: NSColor, y: CGFloat, tracking: CGFloat = 0) {
  let font = NSFont.monospacedSystemFont(ofSize: size, weight: weight)
  let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color, .kern: tracking]
  let s = NSAttributedString(string: text, attributes: attrs)
  let sz = s.size()
  s.draw(at: NSPoint(x: (W - sz.width) / 2, y: y))
}

// The one instruction, plus the fine print under it — in the site's ladder.
draw("Intaglio Labs, Inc.", size: 26, weight: .medium, color: NSColor(white: 0.92, alpha: 1), y: 74)
draw("drag Intaglio Labs into Applications", size: 30, weight: .semibold,
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
