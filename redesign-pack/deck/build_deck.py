"""Builds the Finora Flow client walkthrough deck from live screenshots.

Screens come from `apps/web/deck-shots.mjs` (run against the local stack) into
`shots/`. Then:
    python -m pip install --target .pylib python-pptx
    PYTHONPATH=.pylib python build_deck.py
Outputs Finora_Flow_Client_Walkthrough.pptx next to this file.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from pathlib import Path

from lxml import etree
from PIL import Image
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Inches, Pt

HERE = Path(__file__).resolve().parent
SHOTS = HERE / "shots"
ASSETS = HERE.parents[1] / "apps" / "web" / "src" / "assets"
OUT = HERE / "Finora_Flow_Client_Walkthrough.pptx"

NAVY = RGBColor(0x0E, 0x1A, 0x4B)
INK = RGBColor(0x1F, 0x2A, 0x44)
MUTED = RGBColor(0x5B, 0x6A, 0x92)
BLUE = RGBColor(0x35, 0x69, 0xF4)
VIOLET = RGBColor(0x6D, 0x4C, 0xF0)
GREEN = RGBColor(0x16, 0xA6, 0x6A)
ORANGE = RGBColor(0xE0, 0x6A, 0x2C)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
CANVAS = RGBColor(0xF5, 0xF8, 0xFF)
LINE = RGBColor(0xDB, 0xE3, 0xF5)
TINT = RGBColor(0xEA, 0xF0, 0xFF)

FONT = "Segoe UI"
FONT_BOLD = "Segoe UI Semibold"

SLIDE_W = Inches(13.333)
SLIDE_H = Inches(7.5)

prs = Presentation()
prs.slide_width = SLIDE_W
prs.slide_height = SLIDE_H
BLANK = prs.slide_layouts[6]
TOTAL: list[int] = [0]


# --------------------------------------------------------------- primitives


def set_alpha(shape, alpha: int) -> None:
    """Make a shape's solid fill partly transparent (alpha 0-100000)."""
    fill = shape.fill._xPr.find(qn("a:solidFill"))
    colour = fill[0]
    for old in colour.findall(qn("a:alpha")):
        colour.remove(old)
    element = etree.SubElement(colour, qn("a:alpha"))
    element.set("val", str(alpha))


def veil(slide, width, colour: str = "F6F9FF", stops=((0, 97000), (55000, 90000), (100000, 0))):
    """A left-to-right fade over a background image, so text sits on calm ground."""
    shape = rect(slide, 0, 0, width, SLIDE_H, fill=None)
    sp_pr = shape._element.spPr
    for child in list(sp_pr):
        if child.tag in (qn("a:noFill"), qn("a:solidFill")):
            sp_pr.remove(child)
    grad = etree.Element(qn("a:gradFill"))
    grad.set("rotWithShape", "1")
    gs_list = etree.SubElement(grad, qn("a:gsLst"))
    for pos, alpha in stops:
        gs = etree.SubElement(gs_list, qn("a:gs"))
        gs.set("pos", str(pos))
        clr = etree.SubElement(gs, qn("a:srgbClr"))
        clr.set("val", colour)
        a = etree.SubElement(clr, qn("a:alpha"))
        a.set("val", str(alpha))
    lin = etree.SubElement(grad, qn("a:lin"))
    lin.set("ang", "0")
    lin.set("scaled", "0")
    geom = sp_pr.find(qn("a:prstGeom"))
    geom.addnext(grad)
    return shape


def no_line(shape) -> None:
    shape.line.fill.background()


def soft_shadow(shape, blur: int = 190500, dist: int = 38100, alpha: int = 18000) -> None:
    sp_pr = shape._element.spPr
    effect = etree.SubElement(sp_pr, qn("a:effectLst"))
    outer = etree.SubElement(effect, qn("a:outerShdw"))
    outer.set("blurRad", str(blur))
    outer.set("dist", str(dist))
    outer.set("dir", "5400000")
    outer.set("algn", "t")
    outer.set("rotWithShape", "0")
    colour = etree.SubElement(outer, qn("a:srgbClr"))
    colour.set("val", "2E4A9A")
    a = etree.SubElement(colour, qn("a:alpha"))
    a.set("val", str(alpha))


def rect(slide, x, y, w, h, fill=WHITE, line=None, radius: float | None = None, shape=None):
    kind = shape or (MSO_SHAPE.ROUNDED_RECTANGLE if radius is not None else MSO_SHAPE.RECTANGLE)
    box = slide.shapes.add_shape(kind, x, y, w, h)
    if radius is not None and kind == MSO_SHAPE.ROUNDED_RECTANGLE:
        box.adjustments[0] = radius
    if fill is None:
        box.fill.background()
    else:
        box.fill.solid()
        box.fill.fore_color.rgb = fill
    if line is None:
        no_line(box)
    else:
        box.line.color.rgb = line
        box.line.width = Pt(0.75)
    box.text_frame.text = ""
    return box


def text(
    slide,
    x,
    y,
    w,
    h,
    content,
    size: float = 12,
    colour=INK,
    bold: bool = False,
    align=PP_ALIGN.LEFT,
    anchor=MSO_ANCHOR.TOP,
    spacing: float = 1.1,
    font: str | None = None,
):
    """Add a text box. `content` is a string or a list of (text, style) runs per paragraph."""
    box = slide.shapes.add_textbox(x, y, w, h)
    frame = box.text_frame
    frame.word_wrap = True
    frame.margin_left = frame.margin_right = 0
    frame.margin_top = frame.margin_bottom = 0
    frame.vertical_anchor = anchor
    paragraphs = content if isinstance(content, list) else [content]
    for index, para in enumerate(paragraphs):
        p = frame.paragraphs[0] if index == 0 else frame.add_paragraph()
        p.alignment = align
        p.line_spacing = spacing
        runs = para if isinstance(para, list) else [(para, {})]
        for run_text, style in runs:
            run = p.add_run()
            run.text = run_text
            f = run.font
            f.size = Pt(style.get("size", size))
            is_bold = style.get("bold", bold)
            f.name = style.get("font", font or (FONT_BOLD if is_bold else FONT))
            f.bold = False
            f.color.rgb = style.get("colour", colour)
        if isinstance(para, list) is False and index < len(paragraphs) - 1:
            p.space_after = Pt(4)
    return box


def pill(slide, x, y, label, fill=TINT, colour=BLUE, size=10, pad=0.14, h=0.3):
    width = Inches(pad * 2 + len(label) * size * 0.0078)
    box = rect(slide, x, y, width, Inches(h), fill=fill, radius=0.5)
    frame = box.text_frame
    frame.margin_left = frame.margin_right = Inches(pad)
    frame.margin_top = frame.margin_bottom = 0
    frame.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = frame.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    run = p.add_run()
    run.text = label
    run.font.size = Pt(size)
    run.font.name = FONT_BOLD
    run.font.color.rgb = colour
    return box


def badge(slide, cx, cy, number, size=0.36, fill=BLUE):
    d = Inches(size)
    circle = slide.shapes.add_shape(MSO_SHAPE.OVAL, cx - d // 2, cy - d // 2, d, d)
    circle.fill.solid()
    circle.fill.fore_color.rgb = fill
    circle.line.color.rgb = WHITE
    circle.line.width = Pt(2)
    soft_shadow(circle, blur=76200, dist=19050, alpha=35000)
    frame = circle.text_frame
    frame.margin_left = frame.margin_right = frame.margin_top = frame.margin_bottom = 0
    frame.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = frame.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    run = p.add_run()
    run.text = str(number)
    run.font.size = Pt(12 if size >= 0.34 else 10)
    run.font.name = FONT_BOLD
    run.font.color.rgb = WHITE
    return circle


def image_cover(slide, path: Path, x, y, w, h):
    """Place an image filling the box, cropping the overflow evenly."""
    with Image.open(path) as im:
        iw, ih = im.size
    box_ratio = w / h
    img_ratio = iw / ih
    pic = slide.shapes.add_picture(str(path), x, y, w, h)
    if img_ratio > box_ratio:
        excess = 1 - box_ratio / img_ratio
        pic.crop_left = excess / 2
        pic.crop_right = excess / 2
    else:
        excess = 1 - img_ratio / box_ratio
        pic.crop_top = excess / 2
        pic.crop_bottom = excess / 2
    return pic


#: Markers are given at a panel's top-left; this pulls them onto its corner (CSS px).
MARKER_NUDGE = (12, 16)


@dataclass
class Placed:
    """Maps screenshot coordinates (CSS px) onto the slide."""

    x: int
    y: int
    scale: float
    crop: tuple[int, int, int, int]

    def at(self, px: float, py: float) -> tuple[int, int]:
        cx, cy = self.crop[0], self.crop[1]
        return (int(self.x + (px - cx) * self.scale), int(self.y + (py - cy) * self.scale))


def screenshot(slide, name: str, x, y, max_w, max_h, crop=None, frame=True, center=False) -> Placed:
    """Place a 2x screenshot cropped to `crop` (CSS px) inside the box, framed."""
    path = SHOTS / f"{name}.png"
    with Image.open(path) as im:
        iw, ih = im.size
    css_w, css_h = iw / 2, ih / 2
    x0, y0, x1, y1 = crop or (0, 0, css_w, min(css_h, 900))
    x1, y1 = min(x1, css_w), min(y1, css_h)
    cw, ch = x1 - x0, y1 - y0
    scale = min(max_w / cw, max_h / ch)
    w, h = int(cw * scale), int(ch * scale)
    left = x + (max_w - w) // 2
    top = y + ((max_h - h) // 2 if center else 0)
    if frame:
        pad = Inches(0.06)
        card = rect(slide, left - pad, top - pad, w + pad * 2, h + pad * 2, fill=WHITE, line=LINE, radius=0.03)
        soft_shadow(card)
    pic = slide.shapes.add_picture(str(path), left, top, w, h)
    pic.crop_left = x0 / css_w
    pic.crop_right = 1 - x1 / css_w
    pic.crop_top = y0 / css_h
    pic.crop_bottom = 1 - y1 / css_h
    pic.line.color.rgb = LINE
    pic.line.width = Pt(0.5)
    return Placed(left, top, scale, (x0, y0, x1, y1))


# ------------------------------------------------------------------- frames


def background(slide, atmosphere: bool = True):
    rect(slide, 0, 0, SLIDE_W, SLIDE_H, fill=CANVAS)
    if atmosphere:
        pic = image_cover(slide, ASSETS / "scene" / "app-atmosphere.jpg", 0, 0, SLIDE_W, SLIDE_H)
        pic.name = "atmosphere"


def footer(slide, section: str):
    TOTAL[0] += 1
    number = len(prs.slides)
    slide.shapes.add_picture(
        str(ASSETS / "brand" / "finora-mark.png"), Inches(0.6), Inches(7.02), Inches(0.22), Inches(0.22)
    )
    text(slide, Inches(0.9), Inches(7.04), Inches(6), Inches(0.25),
         [[("Finora Flow", {"bold": True, "colour": NAVY, "size": 9}),
           (f"   ·   Client walkthrough   ·   {section}", {"colour": MUTED, "size": 9})]])
    text(slide, Inches(11.9), Inches(7.04), Inches(0.83), Inches(0.25), str(number),
         size=9, colour=MUTED, align=PP_ALIGN.RIGHT)


def heading(slide, kicker: str, title: str, subtitle: str | None = None, width=12.1):
    text(slide, Inches(0.6), Inches(0.42), Inches(width), Inches(0.3), kicker.upper(),
         size=10, colour=BLUE, bold=True)
    text(slide, Inches(0.6), Inches(0.7), Inches(width), Inches(0.6), title, size=26, colour=NAVY, bold=True)
    if subtitle:
        text(slide, Inches(0.6), Inches(1.28), Inches(width), Inches(0.45), subtitle, size=13, colour=MUTED)


@dataclass
class Callout:
    title: str
    body: str
    at: tuple[float, float] | None = None
    shot: int = 0


def callout_panel(slide, callouts: list[Callout], x, y, w, why: str | None = None, gap=0.14):
    top = y
    for index, item in enumerate(callouts, start=1):
        badge(slide, x + Inches(0.18), top + Inches(0.17), index)
        title_box = text(slide, x + Inches(0.48), top, w - Inches(0.48), Inches(0.3), item.title,
                         size=12.5, colour=NAVY, bold=True)
        lines = max(1, int(len(item.body) / 46) + 1)
        text(slide, x + Inches(0.48), top + Inches(0.3), w - Inches(0.48), Inches(0.22 * lines),
             item.body, size=10.5, colour=MUTED, spacing=1.12)
        top += Inches(0.3 + 0.19 * lines + gap)
        del title_box
    if why:
        box_h = Inches(0.36 + 0.19 * (int(len(why) / 50) + 1))
        card = rect(slide, x, top + Inches(0.04), w, box_h, fill=TINT, radius=0.12)
        del card
        text(slide, x + Inches(0.18), top + Inches(0.14), w - Inches(0.36), Inches(0.24),
             "WHY IT MATTERS", size=9, colour=BLUE, bold=True)
        text(slide, x + Inches(0.18), top + Inches(0.38), w - Inches(0.36), box_h - Inches(0.4),
             why, size=10.5, colour=NAVY, spacing=1.12)


def talk_track(slide, title: str, subtitle: str | None, callouts: list[Callout], why: str | None) -> None:
    """Speaker notes: what is on screen, the points in order, and the close."""
    lines = [title]
    if subtitle:
        lines += ["", subtitle]
    lines += ["", "Walk through:"]
    lines += [f"{index}. {item.title}: {item.body}" for index, item in enumerate(callouts, start=1)]
    if why:
        lines += ["", f"Why it matters: {why}"]
    slide.notes_slide.notes_text_frame.text = "\n".join(lines)


def shot_slide(section, kicker, title, subtitle, name, callouts, why, crop=None, shot_w=8.05, shot_h=4.8):
    slide = prs.slides.add_slide(BLANK)
    background(slide)
    heading(slide, kicker, title, subtitle)
    placed = screenshot(slide, name, Inches(0.6), Inches(1.98), Inches(shot_w), Inches(shot_h), crop=crop)
    for index, item in enumerate(callouts, start=1):
        if item.at:
            bx, by = placed.at(item.at[0] - MARKER_NUDGE[0], item.at[1] - MARKER_NUDGE[1])
            badge(slide, bx, by, index, size=0.32)
    callout_panel(slide, callouts, Inches(0.6 + shot_w + 0.45), Inches(1.95), Inches(12.73 - 0.6 - shot_w - 0.45), why)
    talk_track(slide, title, subtitle, callouts, why)
    footer(slide, section)
    return slide


def two_shot_slide(section, kicker, title, subtitle, left, right, callouts, why=None):
    """Two screenshots side by side; callouts below, each tied to one shot."""
    slide = prs.slides.add_slide(BLANK)
    background(slide)
    heading(slide, kicker, title, subtitle)
    col_w = Inches(5.95)
    placed = []
    for index, (name, crop, label) in enumerate((left, right)):
        x = Inches(0.6) + index * (col_w + Inches(0.23))
        text(slide, x, Inches(1.86), col_w, Inches(0.26), label.upper(), size=9, colour=MUTED, bold=True)
        placed.append(screenshot(slide, name, x, Inches(2.2), col_w, Inches(3.45), crop=crop, center=True))
    for index, item in enumerate(callouts, start=1):
        if item.at:
            bx, by = placed[item.shot].at(item.at[0] - MARKER_NUDGE[0], item.at[1] - MARKER_NUDGE[1])
            badge(slide, bx, by, index, size=0.27)
    # Callouts in a row beneath.
    count = len(callouts) + (1 if why else 0)
    cell_w = (Inches(12.13) - Inches(0.2) * (count - 1)) // count
    for index, item in enumerate(callouts, start=1):
        x = Inches(0.6) + (index - 1) * (cell_w + Inches(0.2))
        badge(slide, x + Inches(0.16), Inches(6.02), index, size=0.3)
        text(slide, x + Inches(0.42), Inches(5.9), cell_w - Inches(0.42), Inches(0.26), item.title,
             size=11.5, colour=NAVY, bold=True)
        text(slide, x + Inches(0.42), Inches(6.16), cell_w - Inches(0.42), Inches(0.75), item.body,
             size=9.5, colour=MUTED, spacing=1.1)
    if why:
        x = Inches(0.6) + len(callouts) * (cell_w + Inches(0.2))
        rect(slide, x, Inches(5.84), cell_w, Inches(1.08), fill=TINT, radius=0.12)
        text(slide, x + Inches(0.16), Inches(5.93), cell_w - Inches(0.32), Inches(0.22), "WHY IT MATTERS",
             size=8.5, colour=BLUE, bold=True)
        text(slide, x + Inches(0.16), Inches(6.14), cell_w - Inches(0.32), Inches(0.75), why,
             size=9.5, colour=NAVY, spacing=1.1)
    talk_track(slide, title, subtitle, callouts, why)
    footer(slide, section)
    return slide


def section_slide(number: str, title: str, line: str, stages: str):
    slide = prs.slides.add_slide(BLANK)
    image_cover(slide, ASSETS / "scene" / "signin-scene.jpg", 0, 0, SLIDE_W, SLIDE_H)
    veil(slide, Inches(9.6))
    text(slide, Inches(0.8), Inches(2.1), Inches(6), Inches(1.1), number, size=66, colour=BLUE, bold=True)
    text(slide, Inches(0.8), Inches(3.2), Inches(6.3), Inches(1.2), title, size=36, colour=NAVY, bold=True, spacing=1.0)
    text(slide, Inches(0.8), Inches(4.45), Inches(6.0), Inches(1.0), line, size=15, colour=MUTED, spacing=1.2)
    text(slide, Inches(0.8), Inches(5.6), Inches(6.2), Inches(0.4), stages, size=11, colour=BLUE, bold=True)
    footer(slide, title)
    return slide


def card_grid(slide, items, x, y, w, cols, card_h, icon_colours=None, title_size=13, body_size=10.5):
    gap = Inches(0.22)
    card_w = (w - gap * (cols - 1)) // cols
    for index, (title_, body, tag) in enumerate(items):
        row, col = divmod(index, cols)
        cx = x + col * (card_w + gap)
        cy = y + row * (card_h + gap)
        card = rect(slide, cx, cy, card_w, card_h, fill=WHITE, line=LINE, radius=0.08)
        soft_shadow(card, alpha=12000)
        colour = (icon_colours or [BLUE])[index % len(icon_colours or [BLUE])]
        stripe = rect(slide, cx + Inches(0.22), cy + Inches(0.24), Inches(0.36), Inches(0.06), fill=colour, radius=0.5)
        del stripe
        if tag:
            text(slide, cx + Inches(0.22), cy + Inches(0.38), card_w - Inches(0.44), Inches(0.22), tag.upper(),
                 size=8.5, colour=colour, bold=True)
        text(slide, cx + Inches(0.22), cy + Inches(0.62 if tag else 0.44), card_w - Inches(0.44), Inches(0.5),
             title_, size=title_size, colour=NAVY, bold=True)
        text(slide, cx + Inches(0.22), cy + Inches(1.0 if tag else 0.84), card_w - Inches(0.44),
             card_h - Inches(1.1), body, size=body_size, colour=MUTED, spacing=1.13)


# ------------------------------------------------------------------ slides

# 1. Title
slide = prs.slides.add_slide(BLANK)
image_cover(slide, ASSETS / "scene" / "signin-scene.jpg", 0, 0, SLIDE_W, SLIDE_H)
veil(slide, Inches(9.8))
slide.shapes.add_picture(str(ASSETS / "brand" / "finora-mark.png"), Inches(0.8), Inches(0.8), Inches(0.62), Inches(0.62))
text(slide, Inches(1.55), Inches(0.86), Inches(4), Inches(0.5),
     [[("Finora ", {"bold": True, "colour": NAVY, "size": 24}), ("Flow", {"bold": True, "colour": BLUE, "size": 24})]])
text(slide, Inches(0.8), Inches(2.05), Inches(6.5), Inches(0.3), "CLIENT WALKTHROUGH", size=11, colour=BLUE, bold=True)
text(slide, Inches(0.8), Inches(2.4), Inches(7.2), Inches(1.9),
     [[("From estimate", {"bold": True, "colour": NAVY, "size": 44})],
      [("to payment, ", {"bold": True, "colour": NAVY, "size": 44}),
       ("in flow.", {"bold": True, "colour": BLUE, "size": 44})]], spacing=0.95)
text(slide, Inches(0.8), Inches(4.3), Inches(6.2), Inches(1.0),
     "A guided tour of the unified platform for intake, approvals, invoices, payments, "
     "reconciliation, reporting, audit and administration.",
     size=15, colour=MUTED, spacing=1.25)
for index, label in enumerate(["Controls first", "Every decision audited", "AI assistive, never in charge"]):
    pill(slide, Inches(0.8) + Inches(2.0) * index, Inches(5.5), label, fill=WHITE, size=10)
text(slide, Inches(0.8), Inches(6.7), Inches(6), Inches(0.3), "Product demonstration  ·  2026", size=10, colour=MUTED)

# 2. The client journey (agenda)
slide = prs.slides.add_slide(BLANK)
background(slide)
heading(slide, "The client journey", "What we will walk through today",
        "Nine stops, in the order money actually moves through your organisation.")
stops = [
    ("01", "The problem", "Why finance operations stall today"),
    ("02", "The platform", "One flow from estimate to payment"),
    ("03", "People and roles", "Who does what, and who may not"),
    ("04", "Intake to record", "Email and uploads become checked data"),
    ("05", "Approve spend", "Estimates, approvals and purchase orders"),
    ("06", "Invoice to payment", "Receipt, approval, bank and supplier"),
    ("07", "Reconcile and close", "Credit cards and month-end accruals"),
    ("08", "Control and oversight", "Segregation, audit and operations"),
    ("09", "Visibility and admin", "Reporting, configuration and value"),
]
for index, (num, title_, body) in enumerate(stops):
    col, row = divmod(index, 3)
    x = Inches(0.6) + col * Inches(4.1)
    y = Inches(2.05) + row * Inches(1.55)
    card = rect(slide, x, y, Inches(3.9), Inches(1.35), fill=WHITE, line=LINE, radius=0.1)
    soft_shadow(card, alpha=10000)
    text(slide, x + Inches(0.28), y + Inches(0.26), Inches(0.9), Inches(0.6), num, size=26, colour=BLUE, bold=True)
    text(slide, x + Inches(1.15), y + Inches(0.3), Inches(2.6), Inches(0.35), title_, size=14, colour=NAVY, bold=True)
    text(slide, x + Inches(1.15), y + Inches(0.66), Inches(2.6), Inches(0.5), body, size=10.5, colour=MUTED)
footer(slide, "Agenda")

# 3. The problem
slide = prs.slides.add_slide(BLANK)
background(slide)
heading(slide, "01 · The business problem", "Finance work is scattered, slow and hard to prove",
        "Most accounts-payable teams run on inboxes, spreadsheets and chasing. That costs time, control and confidence.")
problems = [
    ("Documents arrive everywhere", "Quotes and invoices land in personal inboxes, get re-keyed by hand and lose their provenance on the way.", "Intake"),
    ("Approvals stall", "Nobody can see who holds a request, how long it has waited, or whether the right level signed it.", "Approvals"),
    ("Paying before receiving", "Invoices get paid without anyone outside finance confirming the goods or services actually arrived.", "Receipt"),
    ("Duplicates and overruns slip through", "The same invoice paid twice, or spend quietly exceeding what was approved or ordered.", "Controls"),
    ("Month-end is a scramble", "Card statements, accruals and unpaid commitments are reconciled in spreadsheets under deadline.", "Close"),
    ("Hard to prove to an auditor", "Decisions live in emails and memories; a change of amount or approver cannot be reconstructed.", "Audit"),
]
card_grid(slide, problems, Inches(0.6), Inches(2.0), Inches(12.13), 3, Inches(2.2),
          icon_colours=[ORANGE, ORANGE, ORANGE, ORANGE, ORANGE, ORANGE])
footer(slide, "The business problem")

# 4. The platform
slide = prs.slides.add_slide(BLANK)
background(slide)
heading(slide, "02 · The platform", "One governed flow, from the first email to the audited payment",
        "Finora Flow replaces fragmented tools with a single system of record for every stage of accounts payable.")
pillars = [
    ("One view, end to end", "Estimate, purchase order, invoice, payment package, supplier confirmation and accrual are linked records, not separate spreadsheets.", "Unified"),
    ("Controls enforced by the system", "Approval routes, receipt confirmation, duplicate and overrun checks and segregation of duties are enforced on the server, not by hiding buttons.", "Governed"),
    ("Every decision on the record", "A tamper-evident, hash-chained audit trail records who did what, when, why, and from where.", "Auditable"),
    ("AI that assists and never decides", "Readings and suggestions are grounded in the document and always reviewed by a person. It can be switched off at any time and every workflow still completes.", "Assistive"),
]
card_grid(slide, pillars, Inches(0.6), Inches(2.0), Inches(12.13), 4, Inches(3.3),
          icon_colours=[BLUE, VIOLET, GREEN, BLUE])
text(slide, Inches(0.6), Inches(5.6), Inches(12.1), Inches(0.9),
     [[("Built for your infrastructure: ", {"bold": True, "colour": NAVY, "size": 12}),
       ("runs in Linux containers on your own network, reads a mailbox you control over IMAPS, sends through your SMTP, "
        "and signs users in with your identity provider (OIDC). No dependency on Microsoft Graph or Outlook add-ins.",
        {"colour": MUTED, "size": 12})]], spacing=1.25)
footer(slide, "The platform")

# 5. End-to-end workflow
slide = prs.slides.add_slide(BLANK)
background(slide)
heading(slide, "02 · The end-to-end workflow", "How money moves through Finora Flow",
        "Ten stages, each with a named owner and a control that has to be satisfied before work moves on.")
stages = [
    ("Capture", "Email or upload, malware-scanned, stored immutably", BLUE),
    ("Read & review", "Values extracted with evidence; a person accepts", BLUE),
    ("Estimate", "Request to spend, routed by amount", VIOLET),
    ("Approve", "Matrix-driven route, oldest first", VIOLET),
    ("Commit (PO)", "Purchase order above the threshold", VIOLET),
    ("Invoice", "Validated, linked, duplicate-checked", GREEN),
    ("Confirm receipt", "Named person outside finance signs off", GREEN),
    ("Pay", "Package, manifest, bank reference", ORANGE),
    ("Confirm payment", "Supplier asked; a person concludes", ORANGE),
    ("Close & report", "Cards coded, accruals locked, audit", NAVY),
]
chip_w = Inches(2.28)
chip_h = Inches(1.5)
for index, (name, body, colour) in enumerate(stages):
    row, col = divmod(index, 5)
    x = Inches(0.6) + col * (chip_w + Inches(0.18))
    y = Inches(2.1) + row * (chip_h + Inches(0.55))
    card = rect(slide, x, y, chip_w, chip_h, fill=WHITE, line=LINE, radius=0.1)
    soft_shadow(card, alpha=11000)
    top_bar = rect(slide, x, y, chip_w, Inches(0.09), fill=colour)
    del top_bar
    text(slide, x + Inches(0.18), y + Inches(0.22), Inches(0.6), Inches(0.3), f"{index + 1:02d}", size=11, colour=colour, bold=True)
    text(slide, x + Inches(0.18), y + Inches(0.5), chip_w - Inches(0.3), Inches(0.35), name, size=14, colour=NAVY, bold=True)
    text(slide, x + Inches(0.18), y + Inches(0.86), chip_w - Inches(0.3), Inches(0.6), body, size=9.5, colour=MUTED)
    if col < 4:
        arrow = slide.shapes.add_shape(MSO_SHAPE.RIGHT_ARROW, x + chip_w + Inches(0.02), y + chip_h // 2 - Inches(0.08),
                                       Inches(0.14), Inches(0.16))
        arrow.fill.solid()
        arrow.fill.fore_color.rgb = LINE
        no_line(arrow)
legend = [("Intake", BLUE), ("Spend approval", VIOLET), ("Invoice control", GREEN), ("Payment", ORANGE), ("Close & assurance", NAVY)]
for index, (label, colour) in enumerate(legend):
    x = Inches(0.6) + index * Inches(2.2)
    dot = rect(slide, x, Inches(6.33), Inches(0.14), Inches(0.14), fill=colour, radius=0.5)
    del dot
    text(slide, x + Inches(0.22), Inches(6.28), Inches(1.9), Inches(0.25), label, size=10, colour=MUTED)
footer(slide, "End-to-end workflow")

# 6. Roles
slide = prs.slides.add_slide(BLANK)
background(slide)
heading(slide, "03 · People and roles", "Seven roles, each with a clear job and clear limits",
        "Access is deny-by-default and granted per role. Every screen shows only what that person may do.")
roles = [
    ("Requester", "Raises estimates, confirms goods and services were received.", "My work · Estimates · Invoices"),
    ("Approver", "Decides requests routed to their level; arranges cover while away.", "Approvals · Dashboard · Cover"),
    ("Finance", "Reviews documents, records and codes invoices, manages POs, cards and accruals.", "Documents · Invoices · Cards · Accruals"),
    ("Payment coordinator", "Assembles and submits payment packages; asks suppliers to confirm.", "Payment packages · Vendor confirms"),
    ("Operations", "Keeps intake and services healthy; retries failures; manages quarantine.", "Inbox · Operational health"),
    ("Administrator", "Configures users, routing, thresholds, reference data and retention. Cannot approve.", "Settings"),
    ("Auditor", "Reads everything, changes nothing, verifies the audit chain.", "Audit trail · Reports · Registers"),
]
table_x, table_y = Inches(0.6), Inches(2.0)
col_ws = [Inches(2.4), Inches(5.9), Inches(3.83)]
header_h, row_h = Inches(0.42), Inches(0.56)
hdr = rect(slide, table_x, table_y, sum(col_ws, Emu(0)), header_h, fill=NAVY, radius=0.12)
del hdr
for index, label in enumerate(["ROLE", "WHAT THEY DO", "WHERE THEY WORK"]):
    x = table_x + sum(col_ws[:index], Emu(0)) + Inches(0.22)
    text(slide, x, table_y + Inches(0.12), col_ws[index], Inches(0.25), label, size=9.5, colour=WHITE, bold=True)
for row_index, (role, does, where) in enumerate(roles):
    y = table_y + header_h + Inches(0.06) + row_index * (row_h + Inches(0.05))
    row = rect(slide, table_x, y, sum(col_ws, Emu(0)), row_h, fill=WHITE, line=LINE, radius=0.18)
    del row
    values = [(role, NAVY, True), (does, INK, False), (where, BLUE, True)]
    for index, (value, colour, bold) in enumerate(values):
        x = table_x + sum(col_ws[:index], Emu(0)) + Inches(0.22)
        text(slide, x, y, col_ws[index] - Inches(0.3), row_h, value, size=11 if index != 1 else 10.5,
             colour=colour, bold=bold, anchor=MSO_ANCHOR.MIDDLE)
footer(slide, "People and roles")

# --- Everyday experience
section_slide("03", "The everyday experience", "Sign in once, see what needs you, and find anything in seconds.",
              "Sign-in  ·  Home dashboard  ·  My work  ·  Global search")

shot_slide(
    "Everyday experience", "Secure access", "A calm, branded front door with enterprise sign-in",
    "The workflow the platform runs is shown right on the sign-in page, and it moves.",
    "signin",
    [
        Callout("The whole flow at a glance", "Estimates, Invoices, Approvals and Payments light up in sequence as the flow runs through them.", (578, 232)),
        Callout("Enterprise sign-in", "Work-email sign-in for development; single sign-on through your identity provider in production.", (1000, 500)),
        Callout("Trust, stated plainly", "Every decision audited, AI on your own gateway, segregation of duties enforced.", (1000, 598)),
        Callout("Why it exists, in three lines", "Real-time visibility, enterprise controls and a complete audit trail.", (62, 500)),
    ],
    "First impressions set expectations: a professional, accessible entry point that respects reduced-motion settings and works on any device.",
    crop=(0, 0, 1440, 900),
)

shot_slide(
    "Everyday experience", "Home dashboard", "Everything that matters today, on one screen",
    "Every figure is counted from live records and opens the register behind it. Nothing is projected or invented.",
    "dashboard",
    [
        Callout("Today's priorities", "Approvals waiting, receipts to confirm, packages to submit and blockers, each one click from the work.", (980, 92)),
        Callout("Spend headlines", "Total, approved and pending spend with honest month-over-month change and a monthly trend line.", (272, 302)),
        Callout("Spend by payment type", "Invoices, purchase orders, credit cards and accruals per month, filterable over 6 or 12 months.", (272, 482)),
        Callout("Top vendors", "Where approved spend is concentrated, as a share of the total.", (1008, 482)),
    ],
    "Leaders see the state of the ledger without asking for a report, and every number can be traced back to a record.",
)

two_shot_slide(
    "Everyday experience", "My work and search", "One queue for each person, and a search that finds anything",
    "Nothing hides in a register someone visits less often.",
    ("my-work", (250, 40, 1440, 560), "My work · approver"),
    ("search", (250, 40, 1440, 720), "Global search · Ctrl/⌘ + K"),
    [
        Callout("Oldest first, always", "Approvals, receipt confirmations, document reviews and supplier answers in one list that cannot be re-sorted to bury awkward items.", (272, 232), 0),
        Callout("Named saved views", "Filters subtract kinds of work and can be saved per person.", (398, 168), 0),
        Callout("Federated search", "Estimates, invoices, POs, packages, documents and suppliers in one palette, with state and amount.", (438, 202), 1),
    ],
    "Faster turnaround comes from making waiting work impossible to miss, for the person who has to act on it.",
)

# --- Intake
section_slide("04", "Intake to record", "Supplier email and uploads become checked, evidenced data, safely.",
              "Inbox  ·  Malware scanning  ·  Immutable originals  ·  Document review")

two_shot_slide(
    "Intake to record", "Secure intake", "Supplier email and uploads, scanned and stored as evidence",
    "The platform reads a mailbox you control over IMAPS. Manual uploads follow exactly the same path.",
    ("inbox", (250, 40, 1440, 520), "Inbox"),
    ("message", (250, 40, 1440, 720), "An emailed supplier invoice"),
    [
        Callout("Every arrival accounted for", "Mailbox and uploads side by side; filter by ready, quarantined, needs attention or scanning.", (268, 170), 0),
        Callout("Scanned before anyone opens it", "Each attachment is malware-scanned; anything suspicious is quarantined and never previewed.", (275, 300), 1),
        Callout("Provenance and fingerprints", "Sender, recipient, sizes and a SHA-256 hash of the original, recorded and immutable.", (1105, 300), 1),
    ],
    "Untrusted documents are handled as untrusted data, and you can always prove what arrived, when, and from whom.",
)

shot_slide(
    "Intake to record", "Document review", "Values read from the document, checked by a person",
    "Every value carries its evidence, a confidence level and a one-click way to confirm or correct it.",
    "document-review",
    [
        Callout("Warnings that need a human", "Bank details on a document and other risk signals are flagged and must be acknowledged by a person.", (275, 318)),
        Callout("The original, side by side", "A safe in-browser preview with scripting disabled, served by short-lived signed links.", (275, 606)),
        Callout("Blockers before acceptance", "Everything that stops the reading being accepted, listed in plain language.", (885, 606)),
        Callout("Confidence and evidence per field", "Show on the document, mark as correct, or change it with a reason.", (885, 820)),
    ],
    "Automation removes re-keying, but a named person still accepts the reading, so nothing a model proposes reaches the ledger unchecked.",
    crop=(250, 40, 1440, 1060),
)

# --- Approve spend
section_slide("05", "Approve spend", "Requests are routed by amount to the right people, and nobody approves their own.",
              "Estimates  ·  Approval queue  ·  Decisions  ·  Purchase orders")

shot_slide(
    "Approve spend", "Estimates", "Permission to spend, requested before the money is committed",
    "A requester raises an estimate blank or from an accepted document and sees its route before sending it.",
    "estimates",
    [
        Callout("Views built around the job", "My drafts, mine awaiting approval, everything I raised.", (272, 170)),
        Callout("Who it is waiting on", "The live approval step for every request that is still moving.", (915, 246)),
        Callout("Clear status", "Draft, pending approval, approved, rejected, always as a labelled pill.", (1082, 246)),
        Callout("Raise in one click", "Start blank, or from a quotation already read and accepted in Documents.", (1268, 170)),
    ],
    "Requesters stop chasing approvers by email, because the request itself says where it is and what it is waiting on.",
    crop=(250, 40, 1440, 700),
)

two_shot_slide(
    "Approve spend", "Approvals", "A single queue for approvers, and a decision with context",
    "Estimates, invoices and purchase orders routed to this approver, oldest first.",
    ("approvals", (250, 40, 1440, 560), "Approval queue"),
    ("approval-decision", (250, 40, 1440, 820), "Deciding an estimate"),
    [
        Callout("Only what is theirs now", "A step whose turn has not come is not offered, so the queue is always actionable.", (870, 262), 0),
        Callout("The route, visible", "Each level in order, who is waiting, and whose turn it is.", (970, 280), 1),
        Callout("A recorded decision", "Approve or reject; a rejection needs a reason. Name and time are fixed to the step.", (1038, 476), 1),
    ],
    "Approvers act faster and with less risk: the right person, at the right level, with the record in front of them.",
)

two_shot_slide(
    "Approve spend", "Purchase orders", "Commitments suppliers can bill against, with live capacity",
    "Orders are required above a configurable threshold (initially JMD 50,000) and approved through the same matrix.",
    ("purchase-orders", (250, 40, 1440, 560), "Purchase order register"),
    ("po-detail", (250, 40, 1440, 740), "An open purchase order"),
    [
        Callout("A register of commitments", "Open, awaiting approval and closed orders, with what remains to bill on each.", None, 0),
        Callout("What is left, derived", "Committed, billed so far and still available, calculated from the invoices linked to it.", (970, 280), 1),
        Callout("Overruns refused", "An invoice that would exceed the order is stopped, with the shortfall named.", (272, 280), 1),
    ],
    "Committed spend is controlled before the invoice arrives, not discovered after it is paid.",
)

# --- Invoice to payment
section_slide("06", "Invoice to payment", "Validate, confirm receipt, approve, pay, and ask the supplier.",
              "Invoices  ·  Receipt sign-off  ·  Payment packages  ·  Vendor confirmation")

shot_slide(
    "Invoice to payment", "Invoice register", "Every supplier bill, what it is billed against, and who acts next",
    "Headline figures are counted across the whole register, not just the page on screen.",
    "invoices",
    [
        Callout("Register-wide figures", "Total invoices, outstanding to pay, settled and pending, from one aggregate.", (264, 232)),
        Callout("Waiting on, and overdue", "The person or step it is waiting on, with overdue and incomplete items flagged.", (855, 362)),
        Callout("Status and owner", "Workflow state and the requester accountable for confirming receipt.", (1062, 362)),
    ],
    "Accounts payable sees at a glance what is stuck, what is late and who can unblock it.",
    crop=(250, 40, 1440, 900),
)

shot_slide(
    "Invoice to payment", "Invoice control", "Nothing is paid until someone outside finance confirms it arrived",
    "The invoice itself lists every reason it cannot move yet, and the server enforces the same list.",
    "invoice-detail",
    [
        Callout("Receipt confirmation", "A named requester is asked to confirm the goods or services, and reminded every three working hours.", (970, 280)),
        Callout("Billed against", "Linked estimate or purchase order, with any overrun measured against a configurable tolerance.", (970, 490)),
        Callout("Approval route", "Worked out from the amount and cost centre, shown before it starts.", (970, 694)),
        Callout("Due-date pressure", "Overdue invoices are called out where they are listed and where they are opened.", (272, 580)),
    ],
    "Duplicate invoice numbers from the same supplier are refused by the database itself, so the most expensive mistake in accounts payable cannot happen by accident.",
    crop=(250, 40, 1440, 900),
)

two_shot_slide(
    "Invoice to payment", "Payment packages", "Approved invoices gathered, sent once, and fingerprinted",
    "Assembling, submitting and marking paid are separate permissions held by different people.",
    ("payments", (250, 40, 1440, 440), "Payment package register"),
    ("package-detail", (250, 40, 1440, 1000), "A submitted package"),
    [
        Callout("Being assembled, or sent", "Open packages lead; totals are kept per currency and never added across currencies.", (268, 170), 0),
        Callout("The file the bank received", "A deterministic manifest with a SHA-256 fingerprint recorded at submission.", (272, 532), 1),
        Callout("Evidence of submission", "Bank reference, who sent it and when: what a payment is traced back to.", (970, 730), 1),
    ],
    "The same invoice cannot enter two packages, and nobody can both send money and declare it received.",
)

two_shot_slide(
    "Invoice to payment", "Vendor confirmation", "A supplier's answer is a claim; a person here concludes",
    "After a package is sent, each supplier is asked whether the money arrived, by secure link or recorded by phone.",
    ("vendor-confirmations", (250, 40, 1440, 440), "Confirmation queue"),
    ("check-in-detail", (250, 40, 1440, 1000), "One supplier's check-in"),
    [
        Callout("Whose turn is it?", "Needs a decision, out with suppliers, or concluded, with the amount for each supplier.", (860, 262), 0),
        Callout("Every step, a separate fact", "Sent to bank, supplier asked, supplier answered, checked here, settled.", (265, 270), 1),
        Callout("Concluding is segregated", "Only someone who holds 'mark paid', and did not submit the package, can conclude.", (1068, 685), 1),
    ],
    "Paid means confirmed paid. A supplier saying so never turns an invoice green on its own.",
)

# --- Reconcile and close
section_slide("07", "Reconcile and close", "Card statements coded and closed, accruals generated and locked, on time.",
              "Credit-card periods  ·  Coding and receipts  ·  Month-end accruals  ·  Exports")

shot_slide(
    "Reconcile and close", "Credit-card reconciliation", "Statements imported, coded, receipted and closed",
    "Import a statement CSV into a period; code each line to a GL account and cost centre; match or waive receipts.",
    "card-period",
    [
        Callout("Progress, at a glance", "Lines, period and what is still waiting, such as lines that need coding.", (1128, 302)),
        Callout("Coding per line", "GL account and cost centre, or an exception, with assistive suggestions kept beside the applied values.", (990, 386)),
        Callout("Receipts matched or waived", "A waiver needs a reason, and is recorded against the person who gave it.", (1208, 386)),
    ],
    "The person who coded a period cannot close it, so reconciliation is reviewed by design, not by habit.",
    crop=(250, 40, 1440, 1000),
)

shot_slide(
    "Reconcile and close", "Month-end accruals", "Unpaid commitments proposed, reviewed, locked and exported",
    "Open a period, generate candidates from unpaid invoices, adjust with a reason, finalise and lock.",
    "accrual-period",
    [
        Callout("Generated, not assembled by hand", "Candidates come from the invoices still owed at period end.", (1244, 205)),
        Callout("A decision per line", "Each candidate is finalised or excluded; edits require a reason.", (1262, 418)),
        Callout("Versioned exports", "Draft CSV and XLSX for review; official exports are the signed-off version.", (272, 668)),
    ],
    "Month-end becomes a controlled, repeatable process, and locking is segregated from editing.",
    crop=(250, 40, 1440, 860),
)

# --- Controls and oversight
section_slide("08", "Control and oversight", "Segregation of duties, tamper-evident audit and operational health, built in.",
              "Controls  ·  Audit trail  ·  System health  ·  Intake health")

slide = prs.slides.add_slide(BLANK)
background(slide)
heading(slide, "08 · Controls", "Controls the system enforces, not the policy manual",
        "Every rule below is checked on the server for every request. Hiding a button is never the control.")
controls = [
    ("Segregation of duties", "Whoever raises a request cannot approve it. Whoever records an invoice cannot confirm receipt. Whoever submits a payment cannot mark it paid. Coders cannot close; editors cannot lock.", "SoD"),
    ("Configurable approval matrix", "Amount bands per currency, departmental routes, sequential and parallel steps and delegation. An amount no rule covers is refused, never routed to nobody.", "Approvals"),
    ("Duplicate and overrun checks", "Duplicate supplier invoice numbers refused by the database; overruns against the estimate or PO reported against a tolerance.", "Invoices"),
    ("Mandatory reasons", "Rejection, cancellation, withdrawal, override and correction cannot be recorded without a written reason.", "Workflow"),
    ("Deny by default", "Every action needs a named permission, checked server-side; signed email links carry no authority of their own.", "Access"),
    ("AI has no authority", "AI can propose, never approve, pay, mark paid or change configuration. A kill switch turns it off instantly.", "AI"),
    ("Immutable evidence", "Originals are content-addressed and write-once; financial and audit records are never hard-deleted.", "Evidence"),
    ("Safe concurrency", "Two people editing the same record cannot silently overwrite each other; the second is told to reload.", "Integrity"),
]
card_grid(slide, controls, Inches(0.6), Inches(1.95), Inches(12.13), 4, Inches(2.35),
          icon_colours=[VIOLET, BLUE, GREEN, ORANGE, NAVY, BLUE, GREEN, VIOLET], title_size=12.5, body_size=9.8)
footer(slide, "Control and oversight")

shot_slide(
    "Control and oversight", "Audit trail", "An append-only, hash-chained record of every decision",
    "Auditors read everything and change nothing, and can prove the history has not been rewritten.",
    "audit",
    [
        Callout("Filter by action and subject", "Find every export, configuration change or decision on a record.", (265, 172)),
        Callout("Who, what, when", "Actor, action, record and exact UTC time for every entry, in sequence.", (485, 244)),
        Callout("Tamper-evident hashes", "Each entry is chained to the one before; any edit breaks the chain.", (1160, 244)),
        Callout("Verify the chain", "One click re-computes the chain over any range and reports the result.", (1292, 172)),
    ],
    "Audit preparation stops being an archaeology exercise: the evidence already exists, in order, and can be verified.",
    crop=(250, 40, 1440, 900),
)

two_shot_slide(
    "Control and oversight", "Operational oversight", "The platform tells you when it needs attention",
    "Live status of every dependency and of the mailbox pipeline, in plain language.",
    ("system-health", (250, 40, 1440, 860), "System health"),
    ("intake-health", (250, 40, 1440, 760), "Intake health"),
    [
        Callout("Plain-language impact", "Each service says what stops if it fails, and that queued work resumes.", (268, 418), 0),
        Callout("Fail closed", "If the malware scanner is down, intake stops accepting attachments rather than skipping the scan.", (1020, 600), 0),
        Callout("Mailbox checkpoints", "Last poll, failures, quarantine and oldest unresolved item for every mailbox.", (268, 290), 1),
    ],
    "Operations can prove the pipeline is healthy, and act before a stalled mailbox becomes a late payment.",
)

# --- Visibility and admin
section_slide("09", "Visibility and administration", "Management visibility and a platform your administrators control.",
              "Reports  ·  Approval matrix  ·  Users and roles  ·  Reference data  ·  Policies")

two_shot_slide(
    "Visibility and administration", "Reporting", "Management visibility, from live records",
    "The dashboard for day-to-day oversight; the reports hub for audited exports.",
    ("dashboard-finance", (250, 846, 1440, 1405), "Dashboard · work, activity and health"),
    ("reports", (250, 40, 1440, 560), "Reports hub"),
    [
        Callout("Work by type", "Everything waiting, split by kind, one click from each item.", (268, 858), 0),
        Callout("Recent activity", "What changed most recently, with amounts and who it concerns.", (778, 858), 0),
        Callout("Audited exports", "Audit trail, payment manifests, accrual packs and card periods; every download is recorded.", (268, 170), 1),
    ],
    "Reporting is permission-aware: each person sees only the reports their role may open.",
)

shot_slide(
    "Visibility and administration", "Approval matrix", "Routing rules your administrators own",
    "Rules are data, not code. Changing one retires it and writes a successor, so past approvals stay explicable.",
    "matrix",
    [
        Callout("Per record type", "Separate matrices for estimates, invoices and purchase orders.", (268, 222)),
        Callout("Coherence checked first", "Overlaps, gaps and unstaffed levels are named before the rules are listed.", (268, 316)),
        Callout("Live rules", "Band, currency, required level and step; replace or retire with a reason.", (1140, 360)),
        Callout("Route simulator", "Type any amount and see exactly who would have to approve it.", (268, 728)),
    ],
    "Policy changes take effect on the next submission without a deployment, and in-flight records keep the route they were given.",
    crop=(250, 40, 1440, 1000),
)

two_shot_slide(
    "Visibility and administration", "People and delegation", "Users, roles, approvers and cover while away",
    "Role combinations that would break segregation of duties are refused at the moment they are granted.",
    ("users", (250, 40, 1440, 620), "Users and roles"),
    ("approvers", (250, 40, 1440, 660), "Who approves what"),
    [
        Callout("Accounts and roles", "Create accounts, grant or revoke roles, deactivate with a reason.", (268, 290), 0),
        Callout("Levels staffed", "Who holds Unit Head, Manager, Head of Department and COO, and where.", (268, 218), 1),
        Callout("Cover while away", "Approvers arrange their own cover; administrators can arrange it for someone already absent.", None, 1),
    ],
    "Absence stops being the reason a queue stalls, without weakening who may approve what.",
)

slide = prs.slides.add_slide(BLANK)
background(slide)
heading(slide, "09 · Configuration", "Policies and reference data, administered, not hard-coded",
        "Every change is a recorded act with a reason; nothing requires a release to adjust.")
grid = [
    ("reference", "Reference data", "Vendors, GL accounts and cost centres: the only counterparties money can be paid to."),
    ("thresholds", "PO thresholds", "Per currency: the amount above which a purchase order is required."),
    ("retention", "Retention", "How long each record class is kept; the audit trail is never deleted."),
    ("operational-settings", "Operational settings", "The AI kill switch with a reason, and a read-only snapshot of workflow settings."),
]
cell_w = Inches(5.95)
cell_h = Inches(2.36)
for index, (name, title_, body) in enumerate(grid):
    row, col = divmod(index, 2)
    x = Inches(0.6) + col * (cell_w + Inches(0.23))
    y = Inches(1.95) + row * (cell_h + Inches(0.14))
    card = rect(slide, x, y, cell_w, cell_h, fill=WHITE, line=LINE, radius=0.06)
    soft_shadow(card, alpha=10000)
    text(slide, x + Inches(0.25), y + Inches(0.2), Inches(2.1), Inches(0.35), title_, size=14, colour=NAVY, bold=True)
    text(slide, x + Inches(0.25), y + Inches(0.6), Inches(1.95), Inches(1.6), body, size=10.5, colour=MUTED, spacing=1.15)
    screenshot(slide, name, x + Inches(2.35), y + Inches(0.18), Inches(3.42), cell_h - Inches(0.36),
               crop=(260, 90, 1100, 520), center=True)
footer(slide, "Visibility and administration")

# Accessibility / responsive
slide = prs.slides.add_slide(BLANK)
background(slide)
heading(slide, "Any device", "The same platform on a phone, for approvals on the move",
        "Responsive layouts, keyboard access, visible focus and reduced-motion support throughout.")
for index, (name, label) in enumerate([("phone-signin", "Sign-in"), ("phone-dashboard", "Dashboard")]):
    x = Inches(0.9) + index * Inches(2.85)
    text(slide, x, Inches(1.86), Inches(2.5), Inches(0.26), label.upper(), size=9, colour=MUTED, bold=True)
    screenshot(slide, name, x, Inches(2.18), Inches(2.5), Inches(4.65), crop=(0, 0, 390, 844))
phone_callouts = [
    Callout("Built to accessibility standards", "Labelled controls, status never shown by colour alone, headings in order, visible keyboard focus."),
    Callout("Approve from anywhere", "Queues, records and decisions work at phone width without sideways scrolling."),
    Callout("Motion with restraint", "The animated flow respects the device's reduced-motion setting."),
]
callout_panel(slide, phone_callouts, Inches(7.0), Inches(2.3), Inches(5.7),
              "Approvers are rarely at their desk; decisions should not wait for them to be.")
talk_track(slide, "The same platform on a phone, for approvals on the move", None, phone_callouts,
           "Approvers are rarely at their desk; decisions should not wait for them to be.")
footer(slide, "Visibility and administration")

# Value proposition
slide = prs.slides.add_slide(BLANK)
background(slide)
heading(slide, "Value to your organisation", "What changes when Finora Flow runs your accounts payable",
        "Outcomes the platform is designed to deliver, and the mechanisms that make them hold.")
value = [
    ("Less manual work", "Documents are read with evidence instead of re-keyed; one queue per person replaces inbox chasing; reminders escalate automatically.", "Efficiency"),
    ("Faster approvals", "Requests reach the right approver at once, oldest first, with cover for absence and three-hourly working-time reminders.", "Speed"),
    ("Fewer payment errors", "Receipt confirmation before approval, duplicate refusal, overrun checks and supplier confirmation after payment.", "Accuracy"),
    ("Stronger control", "Segregation of duties, a configurable matrix and mandatory reasons, enforced by the system for every action.", "Control"),
    ("Audit-ready by default", "A hash-chained trail, immutable originals and versioned decisions mean the evidence already exists.", "Assurance"),
    ("Clear visibility", "Live dashboards and registers show spend, commitments and blockers without waiting for a report.", "Insight"),
]
card_grid(slide, value, Inches(0.6), Inches(1.95), Inches(12.13), 3, Inches(2.2),
          icon_colours=[BLUE, VIOLET, GREEN, NAVY, GREEN, BLUE])
footer(slide, "Value")

# Implementation
slide = prs.slides.add_slide(BLANK)
background(slide)
heading(slide, "Working with you", "What we configure together during onboarding",
        "The platform ships with safe, documented defaults. These are the decisions we confirm with your team.")
items = [
    ("Approval bands and levels", "Your real amount bands per currency and department, and who holds each level."),
    ("Thresholds and tolerances", "The PO threshold (default JMD 50,000) and any invoice overrun tolerance (default zero)."),
    ("Identity provider", "Single sign-on through your OIDC provider; local accounts are for development only."),
    ("Mailbox and email", "The intake mailbox forwarding rule, IMAPS access and your SMTP relay."),
    ("Bank file and payment methods", "Your bank's manifest format; today the manifest is downloaded and uploaded to the bank."),
    ("Reference data and calendar", "Vendors, GL accounts, cost centres and your public-holiday calendar for reminders."),
    ("Retention periods", "Confirm the provisional seven- and ten-year defaults against your policy."),
    ("AI and OCR options", "AI is off unless you connect a provider on your gateway; an OCR engine for scanned pages is a deployment choice."),
]
for index, (title_, body) in enumerate(items):
    row, col = divmod(index, 2)
    x = Inches(0.6) + col * Inches(6.18)
    y = Inches(1.95) + row * Inches(1.18)
    card = rect(slide, x, y, Inches(5.95), Inches(1.04), fill=WHITE, line=LINE, radius=0.12)
    del card
    check = rect(slide, x + Inches(0.22), y + Inches(0.3), Inches(0.36), Inches(0.36), fill=TINT, radius=0.5)
    del check
    text(slide, x + Inches(0.22), y + Inches(0.3), Inches(0.36), Inches(0.36), "✓", size=13, colour=BLUE, bold=True,
         align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    text(slide, x + Inches(0.8), y + Inches(0.17), Inches(5.0), Inches(0.3), title_, size=12.5, colour=NAVY, bold=True)
    text(slide, x + Inches(0.8), y + Inches(0.48), Inches(5.0), Inches(0.5), body, size=10, colour=MUTED)
footer(slide, "Working with you")

# Closing
slide = prs.slides.add_slide(BLANK)
image_cover(slide, ASSETS / "scene" / "signin-scene.jpg", 0, 0, SLIDE_W, SLIDE_H)
veil(slide, Inches(9.8))
slide.shapes.add_picture(str(ASSETS / "brand" / "finora-mark.png"), Inches(0.8), Inches(0.8), Inches(0.62), Inches(0.62))
text(slide, Inches(1.55), Inches(0.86), Inches(4), Inches(0.5),
     [[("Finora ", {"bold": True, "colour": NAVY, "size": 24}), ("Flow", {"bold": True, "colour": BLUE, "size": 24})]])
text(slide, Inches(0.8), Inches(2.3), Inches(6.6), Inches(1.2), "Next steps", size=40, colour=NAVY, bold=True)
steps = [
    ("1", "A working session with your finance team", "Walk one of your real invoices through the flow, end to end."),
    ("2", "Confirm your policies", "Approval bands, thresholds, retention and reminders, configured with you."),
    ("3", "Pilot on your infrastructure", "Containers on your network, your mailbox, your identity provider."),
]
for index, (num, title_, body) in enumerate(steps):
    y = Inches(3.4) + index * Inches(0.95)
    badge(slide, Inches(1.0), y + Inches(0.2), num, size=0.42)
    text(slide, Inches(1.45), y, Inches(5.8), Inches(0.35), title_, size=15, colour=NAVY, bold=True)
    text(slide, Inches(1.45), y + Inches(0.37), Inches(5.8), Inches(0.4), body, size=11.5, colour=MUTED)
text(slide, Inches(0.8), Inches(6.55), Inches(6), Inches(0.3), "From estimate to payment, in flow.", size=12,
     colour=VIOLET, bold=True)

prs.save(str(OUT))
print(f"wrote {OUT} with {len(prs.slides)} slides")
