// The DMG window background: plain white with a neutral arrow from the app
// to the Applications folder. Rendered at 2x (1200x800) and
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

// Plain white, like the standard macOS installer reference.
ctx.setFillColor(NSColor.white.cgColor)
ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))

// The arrow sits between the app and Applications icons.
ctx.setStrokeColor(NSColor.lightGray.cgColor)
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
