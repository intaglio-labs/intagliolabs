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

// THE LABEL BAND, and the arithmetic that forced it.
//
// Finder draws icon names in the SYSTEM appearance, which this image cannot
// know: near-white in dark mode, near-black in light. Measured on the shipped
// background (#141412): 13.5:1 in dark mode, and 1.14:1 in light — the names of
// both icons simply absent for anyone not in dark mode.
//
// One colour cannot fix that at AA. For white label text to reach 4.5:1 the
// background must be no lighter than luminance 0.121; for black text to reach
// 4.5:1 it must be no darker than 0.175. The window is empty — there is no such
// colour, and no amount of taste produces one.
//
// At 3:1 the window exists (0.100 to 0.206), and icon labels are the small-bold
// case that bar is written for. #80664a sits at luminance 0.146, almost exactly
// centred: 3.92:1 against dark-mode text and 3.92:1 against light-mode text.
// Balanced on purpose — a band tuned to favour one appearance just moves the
// unreadable case rather than removing it.
//
// Drawn only where the names sit, with a soft vertical fade so it reads as a
// shelf the icons stand on rather than a rectangle stuck to the artwork.
// Sized from where Finder actually puts the names, not from where they look
// like they should go: measured off a mounted DMG, the label text occupies
// roughly y 550-580 in this coordinate space. The band is wider than that on
// both sides so the fade never overlaps a glyph — the ends of a fade are the
// weakest contrast in the whole image, and putting text there would undo the
// point of having it.
let bandTop: CGFloat = 462, bandBottom: CGFloat = 648
let band = NSColor(red: 128/255, green: 102/255, blue: 74/255, alpha: 1)   // #80664a

// Painted as a stack of 1px rows with a ramped alpha rather than a CGGradient.
// The gradient version silently produced nothing — CGGradient's initialiser is
// failable, and `if let` on a nil result is indistinguishable from success in a
// script whose only output is a PNG. Rows cannot fail, and the fade is explicit.
let rows = Int(bandBottom - bandTop)
for i in 0..<rows {
  let t = CGFloat(i) / CGFloat(rows - 1)          // 0 at the top, 1 at the bottom
  // Full strength across the middle, easing out over the top and bottom fifth.
  let a: CGFloat
  if t < 0.12 { a = t / 0.12 }
  else if t > 0.88 { a = (1 - t) / 0.12 }
  else { a = 1 }
  ctx.setFillColor(band.withAlphaComponent(a).cgColor)
  ctx.fill(CGRect(x: 0, y: bandTop + CGFloat(i), width: W, height: 1))
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
