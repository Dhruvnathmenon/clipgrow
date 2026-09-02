# -*- coding: utf-8 -*-
"""Build the ClipGrow Agency Operating System PDF (team-facing).

This script IS the source of truth for docs/ClipGrow-Agency-System.pdf.
Edit the content here, then regenerate:

    pip install reportlab
    python docs/_src/build_agency_pdf.py      # run from the repo root

Do not keep a separate Markdown copy of this document -- it will drift.
"""
import os
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table, TableStyle,
    PageBreak, Flowable, KeepTogether, ListFlowable, ListItem
)

OUT = os.path.join(os.path.dirname(__file__), "..", "ClipGrow-Agency-System.pdf")

INK      = colors.HexColor("#0B120B")
GREEN    = colors.HexColor("#1F8A4C")
GREEN_D  = colors.HexColor("#14622F")
MUTED    = colors.HexColor("#54615A")
LINE     = colors.HexColor("#C9D3CC")
BG_SOFT  = colors.HexColor("#F1F5F2")
BG_WARN  = colors.HexColor("#FFF4E5")
WARN_BD  = colors.HexColor("#E0A458")
BG_BLUE  = colors.HexColor("#EAF2FB")

styles = getSampleStyleSheet()

def S(name, **kw):
    base = kw.pop("parent", styles["Normal"])
    return ParagraphStyle(name, parent=base, **kw)

BODY   = S("body", fontName="Helvetica", fontSize=9.5, leading=14, textColor=INK, spaceAfter=6)
BODYC  = S("bodyc", parent=BODY, spaceAfter=0)
H1     = S("h1", fontName="Helvetica-Bold", fontSize=17, leading=21, textColor=GREEN_D, spaceBefore=6, spaceAfter=10)
H2     = S("h2", fontName="Helvetica-Bold", fontSize=12.5, leading=16, textColor=INK, spaceBefore=14, spaceAfter=5)
H3     = S("h3", fontName="Helvetica-Bold", fontSize=10.5, leading=14, textColor=GREEN_D, spaceBefore=8, spaceAfter=3)
SMALL  = S("small", parent=BODY, fontSize=8.5, leading=11.5, textColor=MUTED)
TITLE  = S("title", fontName="Helvetica-Bold", fontSize=26, leading=30, textColor=GREEN_D, alignment=TA_CENTER)
SUB    = S("sub", fontName="Helvetica", fontSize=11, leading=15, textColor=MUTED, alignment=TA_CENTER)
CELL   = S("cell", parent=BODY, fontSize=8.7, leading=11.5, spaceAfter=0)
CELLB  = S("cellb", parent=CELL, fontName="Helvetica-Bold")

def bullets(items, style=BODY, bullet="–"):
    return ListFlowable(
        [ListItem(Paragraph(t, style), leftIndent=12, value=bullet) for t in items],
        bulletType="bullet", start=bullet, leftIndent=10, bulletFontName="Helvetica",
        bulletFontSize=9, spaceBefore=1, spaceAfter=6,
    )

def table(data, colw, header=True, style_extra=None):
    t = Table(data, colWidths=colw, repeatRows=1 if header else 0)
    ts = [
        ("VALIGN", (0,0), (-1,-1), "TOP"),
        ("LINEBELOW", (0,0), (-1,-2), 0.4, LINE),
        ("TOPPADDING", (0,0), (-1,-1), 5),
        ("BOTTOMPADDING", (0,0), (-1,-1), 5),
        ("LEFTPADDING", (0,0), (-1,-1), 6),
        ("RIGHTPADDING", (0,0), (-1,-1), 6),
    ]
    if header:
        ts += [
            ("BACKGROUND", (0,0), (-1,0), GREEN_D),
            ("TEXTCOLOR", (0,0), (-1,0), colors.white),
            ("FONTNAME", (0,0), (-1,0), "Helvetica-Bold"),
            ("FONTSIZE", (0,0), (-1,0), 8.7),
            ("LINEBELOW", (0,0), (-1,0), 0, colors.white),
        ]
    if style_extra:
        ts += style_extra
    t.setStyle(TableStyle(ts))
    return t

def callout(title, para_html, bg=BG_WARN, bd=WARN_BD):
    inner = [Paragraph(f"<b>{title}</b>", S("cot", parent=BODY, textColor=colors.HexColor('#8a5a12'), spaceAfter=3)),
             Paragraph(para_html, S("cob", parent=BODY, spaceAfter=0))]
    t = Table([[inner]], colWidths=[165*mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,-1), bg),
        ("BOX", (0,0), (-1,-1), 0.8, bd),
        ("LEFTPADDING", (0,0), (-1,-1), 9), ("RIGHTPADDING", (0,0), (-1,-1), 9),
        ("TOPPADDING", (0,0), (-1,-1), 7), ("BOTTOMPADDING", (0,0), (-1,-1), 7),
    ]))
    return t


class OrgChart(Flowable):
    """Two interlinked ladders, side by side.

    LEFT  = staff  : Coach -> Campaign Manager -> Head   (management & training)
    RIGHT = workers: Rookie -> Editor -> Clipper         (the earning pipeline)
    Horizontal arrows show who directly handles whom.
    """
    def __init__(self, width=470):
        Flowable.__init__(self)
        self.width = width
        self.height = 350
        self.LX, self.RX = 112, 356       # column centres
        self.BW = 150                     # box width
        self.ROWS = {"bot": 58, "mid": 145, "top": 236}
        self.BH = {"bot": 42, "mid": 48, "top": 48}

    def _box(self, c, cx, row, title, sub=None, fill=colors.white, tcol=INK, bd=GREEN_D, tag=None):
        x, y, w, h = cx - self.BW/2, self.ROWS[row], self.BW, self.BH[row]
        c.setFillColor(fill); c.setStrokeColor(bd); c.setLineWidth(1.2)
        c.roundRect(x, y, w, h, 6, stroke=1, fill=1)
        c.setFillColor(tcol); c.setFont("Helvetica-Bold", 9)
        c.drawCentredString(cx, y + h - 14, title)
        if sub:
            c.setFont("Helvetica", 6.5); c.setFillColor(MUTED)
            for i, line in enumerate(sub):
                c.drawCentredString(cx, y + h - 24 - i*8, line)
        if tag:
            tc = MUTED if tag == "unpaid" else GREEN
            c.setFont("Helvetica-Oblique", 6)
            c.setFillColor(tc)
            c.drawRightString(x + w - 4, y + 4, tag)
        return x, y, w, h

    def _head(self, c, x1, y1, x2, y2, col):
        import math
        ang = math.atan2(y2 - y1, x2 - x1); L = 5.5
        c.setFillColor(col)
        p = c.beginPath(); p.moveTo(x2, y2)
        p.lineTo(x2 - L*math.cos(ang - 0.42), y2 - L*math.sin(ang - 0.42))
        p.lineTo(x2 - L*math.cos(ang + 0.42), y2 - L*math.sin(ang + 0.42))
        p.close(); c.drawPath(p, fill=1, stroke=0)

    def _up(self, c, x, y1, y2, col=GREEN):        # vertical promotion arrow
        c.setStrokeColor(col); c.setLineWidth(1.2); c.line(x, y1, x, y2)
        self._head(c, x, y1, x, y2, col)

    def _link(self, c, x1, x2, y, col=colors.HexColor("#3E7CB1")):  # horizontal "handles" arrow
        c.setStrokeColor(col); c.setLineWidth(1.1); c.setDash(3, 2)
        c.line(x1, y, x2, y); c.setDash()
        self._head(c, x1, y, x2, y, col)

    def _plabel(self, c, x, y, lines, col=GREEN_D):
        w = 122; h = 6 + len(lines)*7.6
        c.setFillColor(colors.white); c.rect(x - w/2, y - h/2, w, h, fill=1, stroke=0)
        c.setFillColor(col); c.setFont("Helvetica-Oblique", 6.1)
        for i, ln in enumerate(lines):
            c.drawCentredString(x, y + (len(lines)-1)*3.8 - i*7.6, ln)

    def draw(self):
        c = self.canv
        LX, RX, BW = self.LX, self.RX, self.BW
        R = self.ROWS; H = self.BH
        BLUE = colors.HexColor("#3E7CB1")

        # column headers
        c.setFont("Helvetica-Bold", 7.5); c.setFillColor(GREEN_D)
        c.drawCentredString(LX, 322, "STAFF  \u2014  management & training")
        c.drawCentredString(RX, 322, "CLIPPERS  \u2014  the earning pipeline")
        c.setStrokeColor(LINE); c.setLineWidth(0.5)
        c.line(LX - 95, 316, LX + 95, 316); c.line(RX - 95, 316, RX + 95, 316)

        # ---- LEFT ladder ----
        self._box(c, LX, "bot", "COACH",
                  ["reviews rookie videos vs. a", "checklist; sends corrections"], bd=GREEN, tag="unpaid")
        self._box(c, LX, "mid", "CAMPAIGN MANAGER",
                  ["runs one campaign; approves", "clips; coaches its editors"], bd=GREEN, tag="paid")
        self._box(c, LX, "top", "HEAD",
                  ["Dhruv \u00b7 Spandan \u00b7 Endrig", "owns the agency; final say"],
                  fill=colors.HexColor("#E8F5EC"), bd=GREEN_D)
        self._up(c, LX, R["bot"] + H["bot"], R["mid"])
        self._up(c, LX, R["mid"] + H["mid"], R["top"])
        self._plabel(c, LX, (R["bot"] + H["bot"] + R["mid"]) / 2,
                     ["promoted \u2014 pay starts here"])
        self._plabel(c, LX, (R["mid"] + H["mid"] + R["top"]) / 2,
                     ["founders only, for now"])

        # ---- RIGHT ladder ----
        self._box(c, RX, "bot", "ROOKIE",
                  ["learn only \u2014 no campaigns,", "no pay"], fill=BG_SOFT, bd=LINE, tag="unpaid")
        self._box(c, RX, "mid", "EDITOR",
                  ["earn + learn; 1 campaign;", "works under a Campaign Mgr"], bd=GREEN, tag="paid")
        self._box(c, RX, "top", "CLIPPER",
                  ["autonomous; many campaigns;", "self-managed"],
                  fill=colors.HexColor("#E8F5EC"), bd=GREEN_D, tag="paid")
        self._up(c, RX, R["bot"] + H["bot"], R["mid"])
        self._up(c, RX, R["mid"] + H["mid"], R["top"])
        self._plabel(c, RX, (R["bot"] + H["bot"] + R["mid"]) / 2,
                     ["Coach passes their video"])
        self._plabel(c, RX, (R["mid"] + H["mid"] + R["top"]) / 2,
                     ["~20\u201330 clips + a Head's", "principles assessment"])

        # ---- interlinks: who directly handles whom (left -> right, dashed) ----
        lre = LX + BW/2
        rle = RX - BW/2
        cm = (lre + rle) / 2
        # Coach -> Rookie
        yb = R["bot"] + H["bot"]/2
        self._link(c, lre, rle, yb)
        self._plabel(c, cm, yb + 10, ["trains & corrects"], col=BLUE)
        # Campaign Manager -> Editor & Clipper (their campaign work)
        ym = R["mid"] + H["mid"]/2
        self._link(c, lre, rle, ym)
        self._plabel(c, cm, ym + 10, ["directs editors &", "clippers on the campaign"], col=BLUE)
        # Head -> Clipper (rank, assessment, direct handling)
        yt = R["top"] + 24
        self._link(c, lre, rle, yt)
        self._plabel(c, cm, yt + 10, ["assesses & handles directly"], col=BLUE)

        # ---- entry fork ----
        ex, ey, ew, eh = 235 - 88, 8, 176, 28
        c.setFillColor(colors.white); c.setStrokeColor(MUTED); c.setLineWidth(1)
        c.roundRect(ex, ey, ew, eh, 5, stroke=1, fill=1)
        c.setFillColor(INK); c.setFont("Helvetica-Bold", 8)
        c.drawCentredString(235, ey + 16, "JOIN THE SERVER")
        c.setFont("Helvetica", 6.4); c.setFillColor(MUTED)
        c.drawCentredString(235, ey + 6, "open a ticket \u2014 to help, or to clip")
        c.setStrokeColor(MUTED); c.setLineWidth(1)
        c.line(235 - 40, ey + eh, LX, R["bot"]); self._head(c, 235 - 40, ey + eh, LX, R["bot"], MUTED)
        c.line(235 + 40, ey + eh, RX, R["bot"]); self._head(c, 235 + 40, ey + eh, RX, R["bot"], MUTED)
        c.setFont("Helvetica-Oblique", 6); c.setFillColor(MUTED)
        c.drawRightString(LX - 6, (ey + eh + R["bot"]) / 2 - 2, "apply to help")
        c.drawString(RX + 6, (ey + eh + R["bot"]) / 2 + 1, "apply to clip")
        c.drawString(RX + 6, (ey + eh + R["bot"]) / 2 - 8, "(proven: skip to Editor)")

        # legend
        c.setFont("Helvetica-Oblique", 6); c.setFillColor(BLUE)
        c.drawCentredString(235, 300, "- - - >  = who directly handles whom")


class Doc(BaseDocTemplate):
    def __init__(self, path):
        BaseDocTemplate.__init__(self, path, pagesize=A4,
            leftMargin=22*mm, rightMargin=22*mm, topMargin=20*mm, bottomMargin=18*mm,
            title="ClipGrow Agency Operating System", author="ClipGrow")
        fr = Frame(self.leftMargin, self.bottomMargin,
                   self.width, self.height, id="main")
        self.addPageTemplates([PageTemplate(id="p", frames=[fr], onPage=self._chrome)])

    def _chrome(self, canv, doc):
        canv.saveState()
        canv.setFont("Helvetica", 7.5); canv.setFillColor(MUTED)
        canv.drawString(self.leftMargin, A4[1]-14*mm, "ClipGrow \u2014 Agency Operating System")
        canv.drawRightString(A4[0]-self.rightMargin, A4[1]-14*mm, "Internal \u2014 confidential")
        canv.setStrokeColor(LINE); canv.setLineWidth(0.5)
        canv.line(self.leftMargin, A4[1]-16*mm, A4[0]-self.rightMargin, A4[1]-16*mm)
        if doc.page > 1:
            canv.drawCentredString(A4[0]/2, 10*mm, str(doc.page))
        canv.restoreState()


story = []
A = story.append

# ---------------- COVER ----------------
A(Spacer(1, 60))
A(Paragraph("ClipGrow", TITLE))
A(Paragraph("Agency Operating System", S("t2", parent=TITLE, fontSize=16, textColor=INK)))
A(Spacer(1, 14))
A(Paragraph("How the agency runs on Discord \u2014 the roles people hold, how they are "
            "recruited and trained, how campaigns are staffed and run, and how the "
            "money works.", SUB))
A(Spacer(1, 26))
A(callout("Who this is for",
          "The ClipGrow team \u2014 Dhruv, Spandan, Endrig, and anyone brought in to help "
          "run operations. Read it end to end, then bring your questions: the last "
          "section lists the decisions still open.", bg=BG_BLUE, bd=colors.HexColor("#7BA9DE")))
A(Spacer(1, 10))
A(callout("Confidential",
          "This document contains internal pricing and margin figures (\u00a710). Those are "
          "<b>not</b> for clipper-facing materials. Share the document only with the core team."))
A(PageBreak())

# ---------------- 1. WHAT THIS IS ----------------
A(Paragraph("1. What this is and why", H1))
A(Paragraph("ClipGrow runs clipping campaigns for brands. Clippers cut short videos from a "
            "brand\u2019s source material, post them to their own social accounts, and get paid "
            "per 1,000 views. Recruitment and vetting were run out of one WhatsApp group and "
            "it stopped scaling.", BODY))
A(Paragraph("This system replaces that with a Discord-based pipeline where people sort and "
            "train <i>themselves</i> up a clear ladder, campaigns are run by delegated "
            "managers, and the ClipGrow website stays the single source of truth for money "
            "and account credentials.", BODY))
A(Paragraph("Two problems it is built to solve", H3))
A(bullets([
    "<b>Too many unqualified applicants to sort by hand.</b> Most people who show up "
    "cannot edit a video yet. They need to sort and train themselves with almost no staff time.",
    "<b>\u201cEditor\u201d is not \u201cClipper.\u201d</b> An editor can cut a clean video. A "
    "<b>clipper</b> understands virality \u2014 hooks, watch-through, consumer psychology, "
    "account curation, what works in a niche. Closing that gap is the whole point of the ladder.",
]))
A(Paragraph("A third goal runs through everything: <b>control.</b> ClipGrow holds the money "
            "and the credentials. Nobody gets a login, campaign access, or a role until they "
            "have earned the stage they are at \u2014 and taking it back is one action.", BODY))

A(Paragraph("The three systems", H3))
A(table([
    [Paragraph("System", CELLB), Paragraph("Who is in it", CELLB), Paragraph("What it does", CELLB)],
    [Paragraph("<b>Discord</b>", CELL), Paragraph("internal only \u2014 every rank, every staff member", CELL),
     Paragraph("recruitment, training, campaign coordination, roles and access control", CELL)],
    [Paragraph("<b>ClipGrow website</b>", CELL), Paragraph("clippers, clients, admins", CELL),
     Paragraph("system of record: campaigns, participations, view tracking, earnings, payouts, credentials", CELL)],
    [Paragraph("<b>WhatsApp</b>", CELL), Paragraph("existing members, during migration only", CELL),
     Paragraph("being retired \u2014 see \u00a712", CELL)],
], [26*mm, 46*mm, 90*mm]))
A(Paragraph("Rule of thumb: if it is about money, tracking, or credentials it lives in "
            "ClipGrow. If it is about people, training, or campaign coordination it lives in "
            "Discord. The two stay in sync automatically (\u00a713). <b>Clients never enter "
            "Discord</b> \u2014 Spandan handles them directly and they watch progress on the website.", BODY))

# ---------------- 2. HIERARCHY ----------------
A(PageBreak())
A(Paragraph("2. The hierarchy \u2014 two interlinked ladders", H1))
A(Paragraph("There are <b>two ladders</b>, and they run side by side.", BODY))
A(bullets([
    "<b>The clipper ladder</b> (right): <b>Rookie to Editor to Clipper.</b> These are the "
    "people doing the clipping work and earning from it.",
    "<b>The staff ladder</b> (left): <b>Coach to Campaign Manager to Head.</b> These are the "
    "people who run the agency and handle everyone on the clipper ladder.",
]))
A(Paragraph("Both ladders are entered the same way \u2014 anyone in the server opens a ticket: "
            "one to <b>help</b> (start as a Coach), one to <b>clip</b> (start as a Rookie, or "
            "fast-lane straight to Editor if they can already prove it).", BODY))
A(Spacer(1, 4))
A(OrgChart(width=470))
A(Spacer(1, 4))

A(Paragraph("Who directly handles whom", H3))
A(bullets([
    "The <b>Coach</b> handles <b>Rookies</b> \u2014 reviews their practice videos and sends corrections.",
    "The <b>Campaign Manager</b> handles the <b>Editors and Clippers on their campaign</b> \u2014 "
    "sets the rules, approves or rejects clips, answers questions.",
    "The <b>Head</b> handles the <b>Campaign Managers</b> (oversight, escalation) and handles "
    "<b>Clippers directly</b> \u2014 Clippers are autonomous freelancers, so their rank, their "
    "assessment, and anything above a Campaign Manager\u2019s pay grade goes straight to a Head.",
]))

A(Paragraph("The staff pipeline \u2014 and how pay works on it", H3))
A(bullets([
    "<b>Coach is the entry-level staff role, open to anyone in the server</b> (you do not have "
    "to be a clipper). It is <b>unpaid</b> \u2014 it is a way to prove you are reliable and can "
    "give good feedback.",
    "<b>A Coach who does the work well is promoted to Campaign Manager \u2014 and that is where "
    "pay begins.</b> Campaign Managers are paid based on their contribution to the campaigns "
    "they run (structure to be set \u2014 \u00a717).",
    "<b>Head</b> is the founders (Dhruv, Spandan, Endrig) for now. Client Lead (Spandan, "
    "client acquisition, outside Discord) and Tech (Endrig, Discord + the bot) are Head-level "
    "function hats, not separate rungs.",
]))

# ---------------- 3. THE LADDER ----------------
A(Paragraph("3. The clipper ladder in detail", H1))
A(Paragraph("Multiple entry points. You can skip rungs by proving you are ready.", BODY))
A(table([
    [Paragraph("Rank", CELLB), Paragraph("Mode", CELLB), Paragraph("Gets", CELLB),
     Paragraph("Campaigns at once", CELLB), Paragraph("How you move up", CELLB)],
    [Paragraph("<b>Rookie</b>", CELL), Paragraph("Learn only", CELL),
     Paragraph("editing software, training library, practice footage, a personal iteration ticket", CELL),
     Paragraph("none \u2014 no real campaigns, no earnings", CELL),
     Paragraph("a Coach passes their practice video against the checklist", CELL)],
    [Paragraph("<b>Editor</b>", CELL), Paragraph("Earn <b>and</b> learn", CELL),
     Paragraph("a ClipGrow login, real campaign work under a Campaign Manager", CELL),
     Paragraph("<b>exactly 1</b> (hard cap)", CELL),
     Paragraph("post ~20\u201330 clips, feel ready, then a Head runs the principles conversation", CELL)],
    [Paragraph("<b>Clipper</b>", CELL), Paragraph("Earn \u2014 capped only by skill", CELL),
     Paragraph("full autonomy, tool presets, business knowledge, near-zero oversight", CELL),
     Paragraph("several", CELL),
     Paragraph("\u2014 (top of the ladder)", CELL)],
], [20*mm, 26*mm, 44*mm, 30*mm, 42*mm]))
A(Paragraph("Entry point", H3))
A(bullets([
    "No real editing experience -> you start as a <b>Rookie</b>.",
    "Genuine experience, verified -> you start as an <b>Editor</b> (the \u201cfast lane\u201d).",
    "<b>The fast lane caps at Editor.</b> However strong a portfolio is, nobody is made a "
    "Clipper at intake. \u201cClipper\u201d always means someone a Head has personally assessed.",
]))
A(Paragraph("Skipping rungs: at any point you can ask to move up early by submitting proof "
            "(a video, plus \u2014 for Clipper \u2014 demonstrated understanding). The reviewer is the "
            "same person who would normally promote you into that rung; the proof just "
            "triggers it early.", BODY))

# ---------------- 4. INTAKE ----------------
A(Paragraph("4. Getting in \u2014 intake and routing", H1))
A(bullets([
    "<b>Step 1.</b> Person joins the Discord server and accepts the rules (Membership Screening).",
    "<b>Step 2.</b> They can now see the entry channels only: <b>#rules</b>, "
    "<b>#how-it-works</b>, <b>#apply</b>.",
    "<b>Step 3.</b> <b>Everyone fills one short application</b> (a form): how many videos have "
    "you edited (zero is fine), your social accounts, portfolio link, 2\u20133 sample clips.",
]))
A(Paragraph("Auto-routing", H3))
A(bullets([
    "Application shows <b>no real proof</b> -> automatically assigned <b>Rookie</b>, a personal "
    "iteration ticket opens, they are pointed at the Training area. <b>No staff time spent.</b>",
    "Application <b>claims real experience</b> -> flagged to a Coach / a Head for a quick "
    "\u201cfast-lane\u201d check. Holds up -> <b>Editor</b>. Does not -> <b>Rookie</b>.",
]))
A(Paragraph("At ~20\u2013100 applicants a week, only the experience-claim minority ever needs a "
            "human glance \u2014 the cousin can absorb that.", BODY))

# ---------------- 5/6/7 ranks ----------------
A(PageBreak())
A(Paragraph("5. Rookie \u2014 the self-serve training track", H1))
A(Paragraph("<b>Goal:</b> turn someone who can (or cannot yet) edit into an Editor who "
            "reliably delivers clean, on-spec videos.", BODY))
A(Paragraph("What a Rookie gets", H3))
A(bullets([
    "<b>Editing software.</b> (Decision to lock \u2014 \u00a716. Recommendation: free/legit tools "
    "such as CapCut and DaVinci Resolve.)",
    "<b>A training library</b> \u2014 videos, guides, examples \u2014 sequenced into a path. "
    "(This content is currently scattered and needs assembling \u2014 \u00a716.)",
    "<b>Practice source material</b> to edit and experiment with.",
    "<b>One iteration ticket</b> \u2014 their personal thread. Submit a video; a Coach leaves "
    "specific corrections <i>in the same ticket</i>; revise and re-submit; repeat. The whole "
    "back-and-forth stays in one place so progress is visible.",
]))
A(Paragraph("Who reviews: a <b>Coach</b> \u2014 deliberately low-skill, high-volume work driven by "
            "a fixed checklist. Delegable; anyone can be slotted in without retraining.", BODY))
A(Paragraph("Promotion: when a Rookie\u2019s video clears the checklist, the Coach promotes them. "
            "The system then <b>creates their ClipGrow login and DMs it to them</b>, assigns "
            "Editor, removes Rookie, closes the ticket. <b>This is the moment credentials are "
            "issued \u2014 never before.</b>", BODY))

A(Paragraph("6. Editor \u2014 earn and learn", H1))
A(bullets([
    "Works <b>one</b> real campaign at a time (hard cap \u2014 keeps them focused while learning), "
    "posts to their own account, earns per views like anyone.",
    "Works <b>under a Campaign Manager</b>. The Manager sets the rules \u2014 style, do/don\u2019t, "
    "which source material \u2014 and the Editor picks the moments to cut and makes the creative "
    "calls inside those rails. The Manager approves or rejects each clip before it counts "
    "toward pay. (Exact direction level \u2014 \u00a716.)",
    "<b>Gets onto a campaign</b> by browsing the campaign board, applying to one, and "
    "submitting a verification video cut from that campaign\u2019s material; the Campaign "
    "Manager approves it.",
]))

A(Paragraph("7. Clipper \u2014 the autonomous freelancer", H1))
A(Paragraph("A Clipper knows the whole craft and the whole business: hooks, retention, "
            "consumer psychology, niche fit, account curation (aesthetic feed, naming, colour, "
            "theme, cadence), which tools and presets to use, how CPM and view quality work, "
            "what gets a clip disqualified and why.", BODY))
A(bullets([
    "<b>A freelancer, not a managed worker.</b> We do not tell them what to do. They pick "
    "which campaigns to work; we offer incentives to attract them to the ones we need filled.",
    "Near-zero oversight. Several campaigns at once.",
    "Still films a verification video for every campaign they join (every campaign\u2019s style "
    "differs) \u2014 but they are added to the campaign channels instantly on request, and the "
    "video is a fast trust-based check, not a gate.",
]))

A(Paragraph("8. Editor -> Clipper", H1))
A(bullets([
    "The system tracks an Editor\u2019s cumulative posted-clip count. At <b>~20\u201330 clips</b> it "
    "flags them in a staff channel as eligible.",
    "When the Editor feels they have the quality and understand the business, they open a "
    "<b>Level-up ticket</b>.",
    "A <b>Head</b> (Dhruv or Spandan \u2014 nobody else) runs the <b>principles conversation</b>: "
    "questions on hooks, retention, psychology, niche, account curation, the business, and "
    "judgement \u2014 <i>what to do, when, and why</i> \u2014 going back and forth against a shared rubric.",
    "Ready -> promoted. The system swaps Editor for Clipper and unlocks multi-campaign access "
    "and brief browsing.",
    "Not ready -> the Head writes the specific gaps into the ticket; the Editor keeps working "
    "and re-opens it later.",
]))

# ---------------- 9. CAMPAIGNS ----------------
A(PageBreak())
A(Paragraph("9. Campaigns", H1))
A(Paragraph("The Campaign Manager", H3))
A(Paragraph("The middle rung of the staff ladder, and the <b>first paid</b> staff role. "
            "One person per campaign, assigned when the campaign is created. Today the three "
            "Heads fill these; the intent is that <b>Coaches who prove themselves are promoted "
            "into this role</b>, and their pay is tied to the campaigns they run "
            "(comp structure to be set \u2014 \u00a717).", BODY))
A(bullets([
    "<b>Powers:</b> approve/reject submitted clips before they count toward pay; moderate the "
    "campaign channels; a scoped view of the ClipGrow admin portal for their campaign.",
    "<b>Owns:</b> the campaign end to end; making sure every clip complies with the brand "
    "guidelines; every Editor and Clipper on it reports to them; first answer-desk for its "
    "questions; reviewing verification videos; coaching its Editors toward Clipper (the deep "
    "principles assessment still goes to a Head).",
    "<b>Must know:</b> every brand guideline cold; exactly what video type and style the "
    "campaign needs and what \u201cgood\u201d looks like in its niche; the quality-check bar; how to "
    "give fast, specific, actionable feedback; the ClipGrow campaign controls.",
]))
A(Paragraph("Lifecycle", H3))
A(table([
    [Paragraph("Step", CELLB), Paragraph("What happens", CELLB)],
    [Paragraph("<b>Create</b>", CELL), Paragraph("Spandan closes a deal outside Discord and enters the "
        "campaign on the ClipGrow website (name, CPM, budget, min views, max payout, platforms, "
        "brief, source assets). A Head then imports it into Discord \u2014 the system creates its "
        "category and channels (#brief, #submissions, #chat), its role, and a board post \u2014 and "
        "assigns a Campaign Manager, who fills #brief with the detailed style guide.", CELL)],
    [Paragraph("<b>Staff \u2014 Editor</b>", CELL), Paragraph("Editor applies from the board -> private "
        "ticket with the brief -> submits handle + verification video -> Manager reviews -> approves "
        " -> the system creates the participation in ClipGrow, raises the account-access request, "
        "and assigns the campaign role.", CELL)],
    [Paragraph("<b>Staff \u2014 Clipper</b>", CELL), Paragraph("Clipper clicks Join -> gives their handle "
        " -> <b>instantly</b> gets the campaign role, participation, and access request. Posts a "
        "verification clip in the campaign chat; the Manager glances at it and approves the "
        "access so they can go live.", CELL)],
    [Paragraph("<b>Run</b>", CELL), Paragraph("Clippers connect their account on the ClipGrow "
        "dashboard, post, and their links flow into ClipGrow. The Manager approves/rejects each "
        "clip; approved clips accrue earnings against the campaign budget.", CELL)],
    [Paragraph("<b>Control</b>", CELL), Paragraph("Pause / resume / remove a person on a campaign, "
        "or revoke them from the agency \u2014 each action sets Discord <b>and</b> ClipGrow at once, "
        "so they cannot drift.", CELL)],
    [Paragraph("<b>Close</b>", CELL), Paragraph("The campaign is marked completed in ClipGrow (which "
        "frees the connected accounts for reuse), the campaign role is removed from everyone, the "
        "channels are archived, and a wrap-up is posted.", CELL)],
], [26*mm, 136*mm]))

# ---------------- 10. MONEY ----------------
A(PageBreak())
A(Paragraph("10. How the money works", H1))
A(Paragraph("There are two revenue streams: the <b>CPM campaign</b> (the core business) and "
            "<b>video licensing</b> / bounties (a client paying to post a clip on their own "
            "official account).", BODY))

A(Paragraph("10.1  The CPM base", H2))
A(bullets([
    "Clippers are paid <b>per 1,000 views</b> on the clips they post to their own accounts. "
    "The CPM rate is set per campaign (currently around Rs 30\u2013Rs 50 per 1,000 views).",
    "Each campaign has a <b>budget</b> (a cap on total payout) and a <b>max payout per video</b> "
    "(a per-clip ceiling). Both vary campaign to campaign.",
    "<b>A paid clip is closed out for good.</b> Views it gains after payout earn nothing. "
    "(This is a deliberate model choice \u2014 not a period-based one where a viral clip keeps "
    "paying for months.)",
    "Payouts run monthly via UPI, above a minimum withdrawal threshold.",
]))
A(Paragraph("10.2  Why CPM is the right deal for the clipper", H2))
A(bullets([
    "<b>Zero investment, zero risk.</b> No upfront cost, no follower requirement, no equipment "
    "beyond a phone. Anyone can try.",
    "<b>Paid for exactly what they produce.</b> A clip that performs earns more; a clip that "
    "flops costs them nothing but time. There is no salary ceiling on a good week.",
    "<b>They build their own asset.</b> Every clip is posted from the clipper\u2019s own account, "
    "which keeps growing views and followers that are theirs to keep.",
    "<b>Predictable and transparent.</b> The rate, the min-views threshold, and the per-video "
    "cap are all in the brief before they commit. Earnings update on their dashboard as views "
    "come in.",
    "<b>Upside within the budget.</b> A strong clipper working several campaigns can stack "
    "earnings; the only limit per clip is the campaign\u2019s max payout.",
]))
A(Paragraph("10.3  ClipGrow\u2019s 20% management fee", H2))
A(Paragraph("ClipGrow\u2019s core revenue is a <b>20% management fee</b>. The brand funds the "
            "campaign; ClipGrow runs sourcing, distribution, view verification, quality control "
            "and payouts, and takes 20% for it. This is already stated publicly on the site "
            "(\u201c20% Management Fee\u201d) and shown to clippers as the campaign\u2019s commission rate.", BODY))

A(Paragraph("10.4  Bounties / pay-per-video (video licensing)", H2))
A(Paragraph("When a client likes a specific video and wants to post it on their <b>own "
            "official account</b>, they license it from us \u2014 a one-off \u201cpay-per-video.\u201d "
            "It is priced off that campaign\u2019s <b>max payout per video</b> (which differs "
            "campaign to campaign).", BODY))
A(table([
    [Paragraph("", CELLB), Paragraph("Amount", CELLB), Paragraph("As % of max payout", CELLB)],
    [Paragraph("Client pays ClipGrow (\u201cmain-account portion\u201d)", CELL), Paragraph("50% of max payout", CELL), Paragraph("50%", CELL)],
    [Paragraph("ClipGrow keeps (20% of that)", CELL), Paragraph("20% \u00d7 50%", CELL), Paragraph("10%", CELL)],
    [Paragraph("Clipper receives (80% of that)", CELL), Paragraph("80% \u00d7 50%", CELL), Paragraph("40%", CELL)],
], [70*mm, 45*mm, 45*mm]))
A(Paragraph("Worked example \u2014 a campaign with a Rs 10,000 max payout per video:", H3))
A(bullets([
    "Client licenses a clip -> pays ClipGrow <b>Rs 5,000</b> (50% of max payout).",
    "ClipGrow keeps <b>Rs 1,000</b> (20% of Rs 5,000).",
    "Clipper is paid <b>Rs 4,000</b> (80% of Rs 5,000 = 40% of max payout).",
]))
A(callout("Internal \u2014 not for clipper-facing materials",
          "Clippers are told <b>only their own number</b> \u2014 an amount equal to 40% of the "
          "campaign\u2019s max payout per video. They are <b>not</b> shown the \u201c50% of max payout\u201d "
          "client price or the 80/20 split. In every campaign\u2019s clipper-facing terms, state it "
          "as a flat figure, e.g. \u201cRs 4,000 to license this video.\u201d"))
A(Paragraph("10.5  Campaign terms \u2014 the licensing clause (clipper-facing)", H2))
A(Paragraph("From now on, every campaign\u2019s terms must include a clause to this effect:", BODY))
A(callout("Standard clipper-facing clause",
          "\u201cIf the client chooses to license one of your videos to post on their own "
          "official account, ClipGrow will pay you an amount equal to <b>40% of this "
          "campaign\u2019s maximum per-video payout</b> in exchange for that video and the "
          "client\u2019s right to post it.\u201d",
          bg=BG_BLUE, bd=colors.HexColor("#7BA9DE")))
A(bullets([
    "The exact rupee figure is written into each brief (40% of that campaign\u2019s max payout).",
    "<b>Open question for the team:</b> does the licensing payment stack <i>on top of</i> the "
    "view-based earnings the clip has already accrued, or replace them? Decide before the "
    "first bounty is offered \u2014 \u00a716.",
]))

# ---------------- 11. CLIENTS ----------------
A(PageBreak())
A(Paragraph("11. Clients", H1))
A(bullets([
    "Clients <b>never</b> join Discord.",
    "Spandan owns the entire client relationship outside it \u2014 DMs, calls, docs.",
    "Clients have a <b>ClipGrow website login</b> to watch their campaign\u2019s progress and "
    "results. They see budget and spend; they never see what an individual clipper is paid.",
    "Campaigns originate on the ClipGrow website; Discord imports them.",
]))

# ---------------- 12. WHATSAPP ----------------
A(Paragraph("12. WhatsApp migration", H1))
A(Paragraph("(Decision to lock \u2014 \u00a716. Recommended:) new people go straight to Discord now. "
            "Existing WhatsApp members are invited over the next 2\u20134 weeks; known-good people "
            "are fast-tracked straight to Editor (or higher after a Head\u2019s assessment). After "
            "the window, the WhatsApp group closes. One system.", BODY))

# ---------------- 13. SYNC ----------------
A(Paragraph("13. What stays in sync automatically", H1))
A(table([
    [Paragraph("Discord", CELLB), Paragraph("ClipGrow", CELLB)],
    [Paragraph("Editor role", CELL), Paragraph("a clipper account exists, tier = editor", CELL)],
    [Paragraph("Clipper role", CELL), Paragraph("tier = clipper", CELL)],
    [Paragraph("a Discord user <-> their ClipGrow account", CELL), Paragraph("a stored link", CELL)],
    [Paragraph("campaign role", CELL), Paragraph("an active participation in that campaign", CELL)],
    [Paragraph("paused on a campaign", CELL), Paragraph("that participation paused, earnings frozen", CELL)],
    [Paragraph("removed from a campaign", CELL), Paragraph("that participation kicked, earnings frozen", CELL)],
    [Paragraph("Removed role", CELL), Paragraph("ClipGrow account disabled (history kept)", CELL)],
    [Paragraph("campaign channels archived", CELL), Paragraph("campaign marked completed", CELL)],
], [80*mm, 82*mm]))
A(Paragraph("Once a night the system compares the two and reports any drift into a staff "
            "channel for a human to fix. <b>Money \u2014 CPM, earnings, payouts \u2014 stays entirely "
            "inside ClipGrow.</b>", BODY))

# ---------------- 14. TEAM ----------------
A(Paragraph("14. The team \u2014 who wears what", H1))
A(table([
    [Paragraph("Person", CELLB), Paragraph("Roles / hats", CELLB), Paragraph("Owns", CELLB)],
    [Paragraph("<b>Dhruv</b>", CELL), Paragraph("Head, Campaign Manager", CELL),
     Paragraph("oversight, final escalation, Clipper assessment, campaigns", CELL)],
    [Paragraph("<b>Spandan (\u201cSandy\u201d)</b>", CELL), Paragraph("Head, Client Lead, Campaign Manager", CELL),
     Paragraph("all client acquisition and relationships (outside Discord); Clipper assessment; campaigns", CELL)],
    [Paragraph("<b>Endrig</b>", CELL), Paragraph("Head, Tech, Campaign Manager", CELL),
     Paragraph("Discord configuration and the bot; the ClipGrow integration; campaigns", CELL)],
    [Paragraph("<b>Cousin</b>", CELL), Paragraph("Coach", CELL),
     Paragraph("Rookie to Editor review (checklist-driven); general manual ops", CELL)],
], [34*mm, 44*mm, 84*mm]))
A(Paragraph("Beyond this: <b>Coach</b> is open to anyone in the server via a ticket (unpaid); "
            "a Coach who does well is promoted to <b>Campaign Manager</b> (paid). That is the "
            "path to growing the team without hiring.", SMALL))

# ---------------- 15. CHANNELS ----------------
A(PageBreak())
A(Paragraph("15. Channels (the Discord map)", H1))
chan = """<font face="Courier" size="8">
ENTRY               everyone past screening
  #rules  #how-it-works  #apply

COMMUNITY           Rookie + Editor + Clipper
  #announcements  #general  #wins

TRAINING            Rookie (full)  ·  Editor (read)
  #training-library  #software-and-tools  #practice-brief  #your-progress

CAMPAIGN BOARD      Editor + Clipper
  #open-campaigns    one post per live campaign, Apply/Join button
  #campaign-help

CAMPAIGN - <NAME>   campaign role + Campaign Manager + Head
  #&lt;name&gt;-brief        (Clippers can also read this to choose campaigns)
  #&lt;name&gt;-submissions
  #&lt;name&gt;-chat

STAFF               staff only
  #coach-queue       fast-lane checks + Rookie escalations
  #campaign-review   verification-video review
  #level-ups         Editor->Clipper tickets + auto-flags at ~25 clips
  #bot-log           every automated action + nightly drift report
  #creds-audit       who got a login, when (Heads only)
  #staff-chat
</font>"""
A(Paragraph(chan, S("mono", parent=BODY, leading=11)))
A(Paragraph("<b>Paused</b> and <b>Removed</b> are restriction overlays applied on top of "
            "someone\u2019s normal roles.", SMALL))

# ---------------- 16. KNOWLEDGE BAR ----------------
A(Paragraph("16. Knowledge bar per rank", H1))
A(Paragraph("What a person must be able to do to hold each rank. Use this when recruiting, "
            "coaching, and assessing.", BODY))
A(Paragraph("Coach (the entry staff role)", H3))
A(bullets([
    "Does <b>not</b> need to be a clipper. Needs to be reliable, responsive, and able to "
    "write clear, specific feedback.",
    "Knows the Rookie checklist cold and applies it the same way every time.",
    "Escalates anything the checklist does not cover to a Campaign Manager or Head.",
]))
A(Paragraph("Rookie to Editor (the Coach checks)", H3))
A(bullets([
    "Operate the editing software: cuts, trims, captions, music sync, correct aspect ratio and export settings.",
    "Follow a spec: right length, right format, safe margins, caption style.",
    "Take a correction and re-deliver without hand-holding.",
    "Hit a basic quality bar: clean cuts, readable captions, synced audio, no watermarks.",
]))
A(Paragraph("Editor (to work campaigns)", H3))
A(bullets([
    "All of the above, reliably and at speed.",
    "Read a brand brief and stay inside its guidelines.",
    "Pick usable moments from source material.",
    "Meet deadlines; communicate in the campaign channel.",
]))
A(Paragraph("Editor -> Clipper (a Head assesses)", H3))
A(bullets([
    "<b>Hooks:</b> what makes someone stop scrolling in the first 1\u20132 seconds.",
    "<b>Retention:</b> structuring a 20\u201345s clip so people watch to the end.",
    "<b>Consumer psychology:</b> why a viewer shares, follows, or comments.",
    "<b>Niche fit:</b> what performs in this brand\u2019s niche versus another.",
    "<b>Account curation:</b> aesthetic feed, naming, colour grade, consistent theme, posting cadence.",
    "<b>The business:</b> how CPM works, why view quality matters, what gets a clip disqualified, why the brand cares.",
    "<b>Judgement:</b> what to make, when, and why \u2014 able to explain the reasoning, not just follow a template.",
]))
A(Paragraph("Campaign Manager", H3))
A(bullets([
    "Every brand guideline for the campaign, cold \u2014 every do and don\u2019t.",
    "Exactly what video type and style the campaign needs, and what \u201cgood\u201d looks like for its niche.",
    "The quality-check bar and how to apply it consistently.",
    "How to give fast, specific, actionable feedback.",
    "How to coach an Editor toward Clipper.",
    "The ClipGrow admin portal for the campaign: approving/rejecting clips, reading view data, flagging, the payout view.",
    "When to escalate to a Head.",
]))

# ---------------- 17. OPEN DECISIONS ----------------
A(PageBreak())
A(Paragraph("17. Decisions still to lock \u2014 bring your questions here", H1))
A(table([
    [Paragraph("#", CELLB), Paragraph("Decision", CELLB), Paragraph("Current lean", CELLB)],
    [Paragraph("1", CELL), Paragraph("Rookie editing software", CELL),
     Paragraph("free/legit tools (recommended) vs. continuing to provide cracked tools "
               "(legal exposure for the registered company noted)", CELL)],
    [Paragraph("2", CELL), Paragraph("Training curriculum ownership", CELL),
     Paragraph("scattered notes + videos today; someone must collect and sequence them "
               "before the Rookie track can go live", CELL)],
    [Paragraph("3", CELL), Paragraph("Editor direction level", CELL),
     Paragraph("Manager sets rules and the Editor picks the clips (recommended) vs. "
               "Manager hands out specific assignments", CELL)],
    [Paragraph("4", CELL), Paragraph("Coach onboarding", CELL),
     Paragraph("anyone can open a ticket to be a Coach (unpaid). What is the bar to accept "
               "someone, and who screens the applications?", CELL)],
    [Paragraph("5", CELL), Paragraph("WhatsApp", CELL),
     Paragraph("timed sunset (recommended) vs. keep as top-of-funnel vs. broadcast-only", CELL)],
    [Paragraph("6", CELL), Paragraph("Bounty payment stacking", CELL),
     Paragraph("does a video-licensing payment stack on top of the CPM the clip already "
               "earned, or replace it? decide before the first bounty", CELL)],
    [Paragraph("7", CELL), Paragraph("Coach to Campaign Manager promotion", CELL),
     Paragraph("what does a Coach have to do / for how long before they are promoted, and "
               "who decides?", CELL)],
    [Paragraph("8", CELL), Paragraph("Campaign Manager pay", CELL),
     Paragraph("this is the first paid staff role. Flat per-campaign fee, % of campaign spend, "
               "performance bonus, or a mix? Set before promoting the first Coach.", CELL)],
    [Paragraph("9", CELL), Paragraph("Bot hosting", CELL),
     Paragraph("covered in the separate bot build spec \u2014 Endrig\u2019s call", CELL)],
], [8*mm, 44*mm, 110*mm]))
A(Spacer(1, 16))
A(Paragraph("Companion document: <b>ClipGrow Discord Bot \u2014 Build Spec</b> (for Endrig) covers "
            "how the bot is built, how it talks to the ClipGrow website, the API ClipGrow needs "
            "to expose, Cloudflare/credentials setup, and how to work on it together.", SMALL))

Doc(OUT).build(story)
print("WROTE", OUT)
