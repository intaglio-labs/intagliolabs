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

// THE FLOOR, and it is a contrast requirement wearing a design.
//
// Finder draws icon names in the SYSTEM appearance, which a background image
// cannot know. Against #141412 they measure 18.4:1 in dark mode and 1.14:1 in
// light — the light-mode case is black text on near-black, which is what shipped
// and what it looked like.
//
// No single tone fixes that at AA against BOTH, unless it is chosen for it:
// white text needs a background no lighter than luminance 0.121, black text one
// no darker than 0.175. #8a7154 sits at 0.179 and lands 4.59:1 against white and
// 4.57:1 against black — clearing 4.5:1 in both appearances, which is the only
// way a background image can be correct for a setting it cannot read.
//
// It is a FLOOR rather than a plate under each name. Two lozenges sized to the
// labels only work while the icons land exactly where the art expects, and when
// Finder ignored the positions once, they shipped as brown blobs in an empty
// window. A full-width surface cannot be misaligned horizontally, and it reads
// as something the icons stand on rather than something stuck behind them.
let floorColor = NSColor(red: 138/255, green: 113/255, blue: 84/255, alpha: 1)  // #8a7154
// It starts BELOW the arrow, not above it. Run high enough to cover the icons and
// the floor swallows the arrow too — hazelnut on tan is the same contrast problem
// one element further up. The fade begins under the icon bodies and is solid by
// the time it reaches the names, which are the only thing here that needs it.
let floorTop: CGFloat = 455, floorSolid: CGFloat = 545
for yy in stride(from: floorTop, to: H, by: 1) {
  let t = yy < floorSolid ? (yy - floorTop) / (floorSolid - floorTop) : 1
  // ease-in-out so neither end of the fade shows a seam
  let e = t * t * (3 - 2 * t)
  ctx.setFillColor(floorColor.withAlphaComponent(e).cgColor)
  ctx.fill(CGRect(x: 0, y: yy, width: W, height: 1))
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
// Dark, because this line sits ON the floor. Cream on #8a7154 is 1.9:1 — the same
// mistake as the labels, one element down.
draw("drag intaglio labs into Applications", size: 30, weight: .semibold,
     color: NSColor(red: 0.086, green: 0.075, blue: 0.06, alpha: 1), y: 620)  // #16130f

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
