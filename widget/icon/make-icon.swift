// Renders the app icon: the sleeping orb, drawn with CoreGraphics — no
// assets, no dependencies, same ethos as build.sh. Output is a 1024px PNG;
// release.sh downsamples with sips and packs the .icns with iconutil.
//
//   swift widget/icon/make-icon.swift <out.png>
//
// The face is the widget's idle state on the brand (power-hour) gradient:
// 160deg cream -> hazelnut -> phosphor, top-left highlight, cheek blushes,
// closed arc eyes. macOS icon convention keeps the circle inside ~10%
// padding rather than bleeding to the edge.
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon-1024.png"
let S: CGFloat = 1024

let img = NSImage(size: NSSize(width: S, height: S))
img.lockFocus()
guard let ctx = NSGraphicsContext.current?.cgContext else { fatalError("no context") }

let inset: CGFloat = S * 0.10
let orbRect = CGRect(x: inset, y: inset, width: S - 2 * inset, height: S - 2 * inset)
let r = orbRect.width / 2
let c = CGPoint(x: orbRect.midX, y: orbRect.midY)

// Body: the one permitted gradient, at the design's 160deg.
ctx.saveGState()
ctx.addEllipse(in: orbRect)
ctx.clip()
let colors = [
  NSColor(red: 0.949, green: 0.910, blue: 0.831, alpha: 1).cgColor, // #f2e8d4
  NSColor(red: 0.773, green: 0.647, blue: 0.427, alpha: 1).cgColor, // #c5a56d
  NSColor(red: 0.200, green: 1.000, blue: 0.400, alpha: 1).cgColor, // #33ff66
] as CFArray
let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 0.45, 1])!
// 160deg in CSS = down-and-right; flip Y for AppKit's bottom-left origin.
let a = (160.0 - 90.0) * .pi / 180
let dir = CGPoint(x: cos(a), y: sin(a))
ctx.drawLinearGradient(grad,
  start: CGPoint(x: c.x - dir.x * r, y: c.y + dir.y * r),
  end: CGPoint(x: c.x + dir.x * r, y: c.y - dir.y * r),
  options: [])

// Highlight at 32% 26% (from top), radial white falloff.
let hl = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [
  NSColor(white: 1, alpha: 0.5).cgColor,
  NSColor(white: 1, alpha: 0.12).cgColor,
  NSColor(white: 1, alpha: 0).cgColor,
] as CFArray, locations: [0, 0.3, 0.55])!
let hlC = CGPoint(x: orbRect.minX + orbRect.width * 0.32, y: orbRect.maxY - orbRect.height * 0.26)
ctx.drawRadialGradient(hl, startCenter: hlC, startRadius: 0, endCenter: hlC, endRadius: orbRect.width * 0.9, options: [])

// Cheek blushes at 58% down, 12% in from each side.
for side: CGFloat in [0, 1] {
  let bx = side == 0 ? orbRect.minX + orbRect.width * 0.12 + orbRect.width * 0.08
                     : orbRect.maxX - orbRect.width * 0.12 - orbRect.width * 0.08
  let by = orbRect.maxY - orbRect.height * 0.58
  let blush = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [
    NSColor(red: 0.773, green: 0.647, blue: 0.427, alpha: 0.55).cgColor,
    NSColor(red: 0.773, green: 0.647, blue: 0.427, alpha: 0).cgColor,
  ] as CFArray, locations: [0, 1])!
  ctx.saveGState()
  ctx.translateBy(x: bx, y: by)
  ctx.scaleBy(x: 1, y: 0.5)
  ctx.drawRadialGradient(blush, startCenter: .zero, startRadius: 0, endCenter: .zero, endRadius: orbRect.width * 0.11, options: [])
  ctx.restoreGState()
}
ctx.restoreGState()

// Closed eyes: the widget's arcs — a full ellipse ring clipped to its top
// half (never border-top; the taper draws horns). Ring geometry scaled from
// the widget's 13x4 eye / 8 ring / 2.5 stroke.
let eyeW = orbRect.width * 0.30
let ringH = eyeW * 8.0 / 13.0
let stroke = eyeW * 2.5 / 13.0
let visH = ringH / 2
let gap = orbRect.width * 0.10
let eyeY = c.y - orbRect.height * 0.02
let ink = NSColor(red: 0.078, green: 0.078, blue: 0.071, alpha: 0.9) // rgba(20,20,18,.9)
for side: CGFloat in [-1, 1] {
  let cx = c.x + side * (gap / 2 + eyeW / 2)
  ctx.saveGState()
  // Clip window: the arc's box, exactly half the ring tall.
  ctx.clip(to: CGRect(x: cx - eyeW / 2, y: eyeY, width: eyeW, height: visH + stroke))
  let ring = CGRect(x: cx - eyeW / 2 + stroke / 2,
                    y: eyeY - ringH + stroke / 2 + visH,
                    width: eyeW - stroke, height: ringH - stroke)
  ctx.setStrokeColor(ink.cgColor)
  ctx.setLineWidth(stroke)
  ctx.strokeEllipse(in: ring)
  ctx.restoreGState()
}

img.unlockFocus()

guard let tiff = img.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else { fatalError("encode failed") }
try! png.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
