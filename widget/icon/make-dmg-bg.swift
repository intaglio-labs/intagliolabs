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

// THE LABEL PLATES, and the arithmetic that forced them.
//
// Finder draws icon names in the SYSTEM appearance, which a background image
// cannot know. Measured on the shipped DMG: both names render at 13.5:1 against
// #141412 in dark mode and 1.14:1 in light. Not hard to read — absent, for
// everyone who has not turned dark mode on.
//
// No single colour fixes that at AA, and the arithmetic says so rather than
// taste: white label text needs a background no lighter than luminance 0.121 to
// reach 4.5:1, black text needs one no darker than 0.175. The window is empty.
// At 3:1 — the bar written for small bold text, which is what an icon label is —
// the window is 0.100 to 0.206, and #80664a sits at 0.146, almost exactly
// centred. Centred deliberately: a colour tuned to favour one appearance only
// moves the unreadable case rather than removing it.
//
// TWO PLATES RATHER THAN A BAND. The first version ran the colour the full width
// of the window, which worked and looked like a stripe — it also ran under the
// instruction line, which is text this file draws and can already colour for
// itself. Contrast is only needed where Finder writes, so that is the only place
// it goes: one plate under each icon's name, rounded, faded at the edges so it
// reads as a shadow the name sits on rather than a box.
let plateColor = NSColor(red: 128/255, green: 102/255, blue: 74/255, alpha: 1)  // #80664a
let plateTop: CGFloat = 543, plateBottom: CGFloat = 596
// Icon centres, matching the arrow's own geometry below.
for cx in [CGFloat(300), CGFloat(900)] {
  let halfW: CGFloat = 148
  let rows = Int(plateBottom - plateTop)
  for i in 0..<rows {
    let t = CGFloat(i) / CGFloat(rows - 1)
    // Soft top and bottom edge only; the sides are rounded by the inset below.
    let vertical: CGFloat = t < 0.16 ? t / 0.16 : (t > 0.84 ? (1 - t) / 0.16 : 1)
    // Pull the ends in near the top and bottom so the corners read as rounded.
    let inset = halfW * (1 - vertical) * 0.28
    ctx.setFillColor(plateColor.withAlphaComponent(vertical).cgColor)
    ctx.fill(CGRect(x: cx - halfW + inset, y: plateTop + CGFloat(i),
                    width: (halfW - inset) * 2, height: 1))
  }
}

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
