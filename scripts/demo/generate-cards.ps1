# Generates clean, professional, non-overlapping 1920x1080 cards
param([string]$OutDir = 'e:\ripples\demo-out\2026-11-18T18-07-32')

Add-Type -AssemblyName System.Drawing

if (!(Test-Path $OutDir)) {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
}

function New-Canvas {
    param([string]$Filename)
    $bmp = New-Object System.Drawing.Bitmap(1920, 1080)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
    $g.Clear([System.Drawing.ColorTranslator]::FromHtml('#0d1117'))
    return @{ Bitmap = $bmp; Graphics = $g; Path = (Join-Path $OutDir $Filename) }
}

function Save-Canvas {
    param($canvas)
    $canvas.Bitmap.Save($canvas.Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $canvas.Graphics.Dispose()
    $canvas.Bitmap.Dispose()
    Write-Host "Created: $($canvas.Path)"
}

function Draw-RoundedRect {
    param($g, $pen, $brush, [float]$x, [float]$y, [float]$w, [float]$h, [float]$r)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($x, $y, $r * 2, $r * 2, 180, 90)
    $path.AddArc($x + $w - $r * 2, $y, $r * 2, $r * 2, 270, 90)
    $path.AddArc($x + $w - $r * 2, $y + $h - $r * 2, $r * 2, $r * 2, 0, 90)
    $path.AddArc($x, $y + $h - $r * 2, $r * 2, $r * 2, 90, 90)
    $path.CloseFigure()
    if ($brush) { $g.FillPath($brush, $path) }
    if ($pen) { $g.DrawPath($pen, $path) }
    $path.Dispose()
}

$fontHeadLarge = New-Object System.Drawing.Font('Segoe UI', 52, [System.Drawing.FontStyle]::Bold)
$fontHeadMid   = New-Object System.Drawing.Font('Segoe UI', 38, [System.Drawing.FontStyle]::Bold)
$fontSection   = New-Object System.Drawing.Font('Segoe UI', 60, [System.Drawing.FontStyle]::Bold)
$fontSub       = New-Object System.Drawing.Font('Segoe UI', 24, [System.Drawing.FontStyle]::Regular)
$fontSubBold   = New-Object System.Drawing.Font('Segoe UI', 24, [System.Drawing.FontStyle]::Bold)
$fontBody      = New-Object System.Drawing.Font('Segoe UI', 19, [System.Drawing.FontStyle]::Regular)
$fontBodyBold  = New-Object System.Drawing.Font('Segoe UI', 19, [System.Drawing.FontStyle]::Bold)
$fontSmall     = New-Object System.Drawing.Font('Segoe UI', 15, [System.Drawing.FontStyle]::Regular)
$fontMono      = New-Object System.Drawing.Font('Consolas', 17, [System.Drawing.FontStyle]::Regular)

$brushWhite = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#ffffff'))
$brushCyan  = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#00d7ff'))
$brushTeal  = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#2dd4bf'))
$brushGray  = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#94a3b8'))
$brushDark  = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#161b22'))
$brushCard  = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#1c2128'))
$brushAmber = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#fbbf24'))

$penBorder = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#30363d'), 1.5)
$penCyan   = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#00d7ff'), 2.0)
$penTeal   = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#2dd4bf'), 2.0)
$penAccent = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#38bdf8'), 2.0)
$penAmber  = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#fbbf24'), 2.0)

$centerFormat = New-Object System.Drawing.StringFormat
$centerFormat.Alignment = [System.Drawing.StringAlignment]::Center
$centerFormat.LineAlignment = [System.Drawing.StringAlignment]::Center

$leftFormat = New-Object System.Drawing.StringFormat
$leftFormat.Alignment = [System.Drawing.StringAlignment]::Near
$leftFormat.LineAlignment = [System.Drawing.StringAlignment]::Center

# ==========================================
# 1. Opening Card 1: Problem Introduction
# ==========================================
$c = New-Canvas 'open_01.png'
$g = $c.Graphics

Draw-RoundedRect $g $penCyan $brushDark 830 330 260 44 8
$g.DrawString('THE AI AGENT DILEMMA', $fontSmall, $brushCyan, 960, 352, $centerFormat)

$g.DrawString('AI coding agents are becoming powerful.', $fontHeadMid, $brushWhite, 960, 460, $centerFormat)
$g.DrawString('But autonomy creates a trust problem.', $fontHeadMid, $brushCyan, 960, 550, $centerFormat)
$g.DrawString('When an agent edits code across multiple files, developers need proof, control, and resilience.', $fontBody, $brushGray, 960, 650, $centerFormat)

Save-Canvas $c

# ==========================================
# 2. Opening Card 2: The Four Questions
# ==========================================
$c = New-Canvas 'open_02.png'
$g = $c.Graphics

$g.DrawString('AUTONOMY CREATES A TRUST PROBLEM', $fontHeadMid, $brushWhite, 960, 140, $centerFormat)
$g.DrawString('Four fundamental questions every engineering team must answer:', $fontSub, $brushGray, 960, 205, $centerFormat)

$questions = @(
    @{ Q = "What did the agent change?"; Desc = "Unreviewed batch writes corrupt codebases. Every hunk must be isolated, inspectable, and reversible."; Color = "#38bdf8" },
    @{ Q = "Why did it select those files?"; Desc = "Autonomous retrieval without context evidence is a black box. File selection requires receipts."; Color = "#2dd4bf" },
    @{ Q = "Did the changes actually pass tests?"; Desc = "Syntactic completion is not working software. Agents must verify changes with real test suites."; Color = "#fbbf24" },
    @{ Q = "What happens when the model fails?"; Desc = "API rate limits, 503s, and timeouts happen. Workflows must gracefully fall back to local models."; Color = "#f87171" }
)

$startY = 290
for ($i = 0; $i -lt $questions.Count; $i++) {
    $item = $questions[$i]
    $boxY = $startY + ($i * 155)
    
    Draw-RoundedRect $g $penBorder $brushDark 260 $boxY 1400 125 10
    
    # Accent indicator
    $penItem = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml($item.Color), 4.0)
    $g.DrawLine($penItem, 262, ($boxY + 20), 262, ($boxY + 105))
    $penItem.Dispose()
    
    $brushQ = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml($item.Color))
    $g.DrawString("0$($i+1)", $fontMono, $brushQ, 305, ($boxY + 42), $leftFormat)
    $g.DrawString($item.Q, $fontSubBold, $brushWhite, 365, ($boxY + 42), $leftFormat)
    $g.DrawString($item.Desc, $fontBody, $brushGray, 365, ($boxY + 84), $leftFormat)
    $brushQ.Dispose()
}

Save-Canvas $c

# ==========================================
# 3. Opening Card 3: Introducing Ripple
# ==========================================
$c = New-Canvas 'open_03.png'
$g = $c.Graphics

# Top pill
Draw-RoundedRect $g $penBorder $brushDark 760 180 400 44 8
$g.DrawString('TRUEFORGE FORGE-A-THON ROUND 1', $fontSmall, $brushTeal, 960, 202, $centerFormat)

$g.DrawString('RIPPLE', $fontSection, $brushCyan, 960, 320, $centerFormat)
$g.DrawString('An editor-native coding agent built for control, transparency and resilience.', $fontSubBold, $brushWhite, 960, 415, $centerFormat)
$g.DrawString('Pallets/Flask 3.1.3 Acceptance Suite (Tasks A, B, and C in order)', $fontSub, $brushGray, 960, 470, $centerFormat)

# 3 Pillars preview
$pX = 310
$pillars = @(
    @{ Name = "CONTROL"; Desc = "Fenced edits · Per-hunk review · Atomic undo" },
    @{ Name = "TRANSPARENCY"; Desc = "Git co-change retrieval · Budget receipts · TrueForge sessions" },
    @{ Name = "RESILIENCE"; Desc = "Automatic local model fallback · Zero workspace corruption" }
)
for ($i = 0; $i -lt 3; $i++) {
    $x = $pX + ($i * 450)
    Draw-RoundedRect $g $penBorder $brushDark $x 560 410 130 10
    $g.DrawString($pillars[$i].Name, $fontSubBold, $brushCyan, ($x + 205), 600, $centerFormat)
    $g.DrawString($pillars[$i].Desc, $fontSmall, $brushGray, ($x + 205), 645, $centerFormat)
}

# Footer disclosure
Draw-RoundedRect $g $penBorder $brushCard 360 840 1200 60 8
$g.DrawString('Scripted demo: clicks and typing are automated; the models, edits, tests and results are real.', $fontSmall, $brushGray, 960, 870, $centerFormat)

Save-Canvas $c

# ==========================================
# 4. Architecture Diagram (Clean Vertical Flow)
# ==========================================
$c = New-Canvas 'arch_diagram.png'
$g = $c.Graphics

$g.DrawString('SYSTEM ARCHITECTURE', $fontHeadMid, $brushWhite, 960, 65, $centerFormat)
$g.DrawString('Ripple separates the editor experience from the TrueForge agent runtime', $fontSub, $brushGray, 960, 115, $centerFormat)

$arrowPen = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#00d7ff'), 2.5)
$arrowCap = New-Object System.Drawing.Drawing2D.AdjustableArrowCap(5, 5)
$arrowPen.CustomEndCap = $arrowCap

# Box 1: VS Code Extension Host
Draw-RoundedRect $g $penAccent $brushDark 480 160 960 85 10
$g.DrawString('VS Code Extension Host', $fontSubBold, $brushCyan, 960, 185, $centerFormat)
$g.DrawString('Editor Interface · Context Retrieval Engine · Staged Diff Tabs · Human Approval', $fontBody, $brushWhite, 960, 220, $centerFormat)

# Arrow 1: VS Code -> MCP
$g.DrawLine($arrowPen, 960, 245, 960, 275)

# Box 2: MCP Tool Server
Draw-RoundedRect $g $penBorder $brushCard 480 275 960 85 10
$g.DrawString('MCP / SDK Integration (127.0.0.1 Bearer Token)', $fontSubBold, $brushTeal, 960, 300, $centerFormat)
$g.DrawString('read_file · search_workspace · retrieve_context · propose_write · run_command', $fontMono, $brushWhite, 960, 335, $centerFormat)

# Arrow 2: MCP -> TrueForge
$g.DrawLine($arrowPen, 960, 360, 960, 390)

# Box 3: TrueForge Agent Runtime
Draw-RoundedRect $g $penAccent $brushDark 480 390 960 95 10
$g.DrawString('TrueForge Agent Runtime (Local Server)', $fontSubBold, $brushCyan, 960, 418, $centerFormat)
$g.DrawString('Autonomous Agent Loop · Tool Approval Lifecycle · Session Compaction (12k threshold) · Turn Events', $fontBody, $brushWhite, 960, 455, $centerFormat)

# Arrow 3: TrueForge -> Model Adapter
$g.DrawLine($arrowPen, 960, 485, 960, 515)

# Box 4: Model Adapter Layer
Draw-RoundedRect $g $penBorder $brushCard 480 515 960 75 10
$g.DrawString('Model Adapter Layer', $fontSubBold, $brushAmber, 960, 538, $centerFormat)
$g.DrawString('Multi-Provider Routing · Failure Detection · Automatic Failover', $fontBody, $brushGray, 960, 568, $centerFormat)

# Branching arrows
$arrowBranchL = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#00d7ff'), 2.5)
$arrowBranchL.CustomEndCap = $arrowCap
$arrowBranchR = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#2dd4bf'), 2.5)
$arrowBranchR.CustomEndCap = $arrowCap

$g.DrawLine($arrowBranchL, 800, 590, 720, 625)
$g.DrawLine($arrowBranchR, 1120, 590, 1200, 625)

# Sub-box Gemini (Left)
Draw-RoundedRect $g $penAccent $brushDark 480 625 460 90 10
$g.DrawString('Gemini 3.5 Flash-Lite (Primary)', $fontSubBold, $brushCyan, 710, 655, $centerFormat)
$g.DrawString('Remote API · Fast token streaming · 128k context', $fontSmall, $brushGray, 710, 690, $centerFormat)

# Sub-box Ollama (Right)
Draw-RoundedRect $g $penTeal $brushDark 980 625 460 90 10
$g.DrawString('Qwen 2.5 Coder 7B (Local Fallback)', $fontSubBold, $brushTeal, 1210, 655, $centerFormat)
$g.DrawString('Ollama instance (127.0.0.1:11434) · Zero cloud dependencies', $fontSmall, $brushGray, 1210, 690, $centerFormat)

# Arrows converging down to Human Review
$g.DrawLine($arrowPen, 710, 715, 820, 755)
$g.DrawLine($arrowPen, 1210, 715, 1100, 755)

# Box 5: Human Review & Diff Safety Pipeline
Draw-RoundedRect $g $penBorder $brushDark 340 755 1240 120 10
$g.DrawString('Reviewable Changes Returned to Developer', $fontSubBold, $brushWhite, 960, 785, $centerFormat)
$g.DrawString('1. Propose Edits (Staged Only)   -->   2. Approval Opens Diff Tab   -->   3. Per-Hunk Accept/Reject   -->   4. Single Atomic Undo', $fontBodyBold, $brushTeal, 960, 830, $centerFormat)

# Side return loop to Extension
$sidePen = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#38bdf8'), 1.5)
$sidePen.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dash
$g.DrawLine($sidePen, 340, 815, 260, 815)
$g.DrawLine($sidePen, 260, 815, 260, 202)
$sidePen.CustomEndCap = $arrowCap
$g.DrawLine($sidePen, 260, 202, 475, 202)
$g.DrawString('Fenced Edits', $fontSmall, $brushCyan, 260, 480, $centerFormat)

$arrowPen.Dispose()
$arrowBranchL.Dispose()
$arrowBranchR.Dispose()
$sidePen.Dispose()
$arrowCap.Dispose()

Save-Canvas $c

# ==========================================
# 5. Section 01: CONTROL
# ==========================================
$c = New-Canvas 'sec_01_control.png'
$g = $c.Graphics

Draw-RoundedRect $g $penCyan $brushDark 860 360 200 44 8
$g.DrawString('DEMONSTRATION', $fontSmall, $brushCyan, 960, 382, $centerFormat)

$g.DrawString('01 — CONTROL', $fontSection, $brushWhite, 960, 480, $centerFormat)
$g.DrawString('Every code change remains reviewable.', $fontSubBold, $brushCyan, 960, 560, $centerFormat)
$g.DrawString('Task A: Inline edit on pallets/flask with per-hunk accept/reject and atomic undo', $fontBody, $brushGray, 960, 640, $centerFormat)

Save-Canvas $c

# ==========================================
# 6. Section 02: TRANSPARENCY
# ==========================================
$c = New-Canvas 'sec_02_transparency.png'
$g = $c.Graphics

Draw-RoundedRect $g $penTeal $brushDark 860 360 200 44 8
$g.DrawString('DEMONSTRATION', $fontSmall, $brushTeal, 960, 382, $centerFormat)

$g.DrawString('02 — TRANSPARENCY', $fontSection, $brushWhite, 960, 480, $centerFormat)
$g.DrawString('An agent that can work across files — and explain its context.', $fontSubBold, $brushTeal, 960, 560, $centerFormat)
$g.DrawString('Task B: Multi-file feature addition with git co-change retrieval, budget receipts, and session compaction', $fontBody, $brushGray, 960, 640, $centerFormat)

Save-Canvas $c

# ==========================================
# 7. Section 03: RESILIENCE
# ==========================================
$c = New-Canvas 'sec_03_resilience.png'
$g = $c.Graphics

Draw-RoundedRect $g $penAmber $brushDark 860 360 200 44 8
$g.DrawString('DEMONSTRATION', $fontSmall, $brushAmber, 960, 382, $centerFormat)

$g.DrawString('03 — RESILIENCE', $fontSection, $brushWhite, 960, 480, $centerFormat)
$g.DrawString('Model failure should not mean workflow failure.', $fontSubBold, $brushAmber, 960, 560, $centerFormat)
$g.DrawString('Task C: Automatic fallback to local 7B model when primary endpoint fails, preserving workspace safety', $fontBody, $brushGray, 960, 640, $centerFormat)

Save-Canvas $c

# ==========================================
# 8. Closing Card: Pillars & Tagline
# ==========================================
$c = New-Canvas 'closing.png'
$g = $c.Graphics

$g.DrawString('RIPPLE', $fontSection, $brushCyan, 960, 160, $centerFormat)
$g.DrawString('Trust the workflow. Not just the model.', $fontSubBold, $brushWhite, 960, 240, $centerFormat)
$g.DrawString('An editor-native autonomous coding workflow powered by TrueForge', $fontSub, $brushTeal, 960, 295, $centerFormat)

$pillars3 = @(
    @{ Name = "CONTROL"; Title = "Human-reviewed changes"; Bullets = "• Inline editing in active tab`n• Per-hunk independent review`n• Instant turn cancellation`n• Atomic single-step undo" },
    @{ Name = "TRANSPARENCY"; Title = "Inspectable context & execution"; Bullets = "• Explainable context receipts`n• Git co-change file ranking`n• Embedded TrueForge session view`n• Automatic context compaction" },
    @{ Name = "RESILIENCE"; Title = "Local model fallback"; Bullets = "• Primary & fallback routing`n• Automatic failover on connection drop`n• Clean workspace invariant`n• Zero direct disk writes" }
)

for ($i = 0; $i -lt 3; $i++) {
    $x = 220 + ($i * 510)
    Draw-RoundedRect $g $penBorder $brushDark $x 370 470 360 12
    
    $p = $pillars3[$i]
    $g.DrawString($p.Name, $fontSubBold, $brushCyan, ($x + 235), 415, $centerFormat)
    $g.DrawString($p.Title, $fontBodyBold, $brushWhite, ($x + 235), 455, $centerFormat)
    
    $penDiv = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#30363d'), 1.0)
    $g.DrawLine($penDiv, ($x + 30), 490, ($x + 440), 490)
    $penDiv.Dispose()
    
    $g.DrawString($p.Bullets, $fontBody, $brushGray, ($x + 35), 590, $leftFormat)
}

# Footer disclosure
Draw-RoundedRect $g $penBorder $brushCard 220 780 1480 85 8
$g.DrawString('Models: Gemini 3.1 & 3.5 Flash-Lite (free tier) · Local Qwen 2.5 Coder 7B (Ollama)', $fontBodyBold, $brushWhite, 960, 808, $centerFormat)
$g.DrawString('Total Model Cost: $0.00 | TrueForge Forge-a-thon Round 1 Submission', $fontSmall, $brushTeal, 960, 842, $centerFormat)

Save-Canvas $c
Write-Host "All cards updated with zero overlap!"
