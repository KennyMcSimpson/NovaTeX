-- NovaTeX Academic Markdown Lua Filter
-- Produces clean, token-efficient Markdown for AI agents & human editing
-- Preserves $...$ / $$...$$ math and [@bibkey] citations while stripping noisy attributes
-- Compatible with BOTH Pandoc 2.12 (Lua 5.3) and Pandoc 3.x (Lua 5.4)

local function empty_attr()
  return pandoc.Attr("", {}, {})
end

function Header(el)
  -- Strip noisy {.unnumbered} and auto-generated anchor IDs
  el.identifier = ""
  el.classes = {}
  el.attributes = {}
  return el
end

function Div(el)
  -- Unwrap fenced/native divs (e.g. ::: {.center}, ::: {#refs}) into plain blocks
  return el.content
end

function Span(el)
  -- Unwrap bracketed/native spans (e.g. [text]{.underline}) into plain inlines
  return el.content
end

function Image(el)
  -- Keep clean alt text & src, strip noisy width/height/style attributes unless meaningful
  el.identifier = ""
  el.classes = {}
  el.attributes = {}
  return el
end

function Link(el)
  el.identifier = ""
  el.classes = {}
  el.attributes = {}
  return el
end

function CodeBlock(el)
  -- Keep only the first language class if present, drop noisy attributes
  local lang = nil
  if el.classes and #el.classes > 0 then
    lang = el.classes[1]
  end
  el.identifier = ""
  el.classes = lang and { lang } or {}
  el.attributes = {}
  return el
end

function RawBlock(el)
  -- Drop empty or layout-only LaTeX raw blocks that clutter AI-facing Markdown
  if el.format == "latex" or el.format == "tex" then
    local trimmed = el.text:gsub("^%s+", ""):gsub("%s+$", "")
    if trimmed == ""
      or trimmed == "\\newpage"
      or trimmed == "\\clearpage"
      or trimmed == "\\pagebreak"
      or trimmed == "\\maketitle"
      or trimmed == "\\tableofcontents"
      or trimmed == "\\noindent"
      or trimmed:match("^\\vspace%b{}$")
      or trimmed:match("^\\hspace%b{}$")
      or trimmed:match("^\\bibliographystyle%b{}$")
      or trimmed:match("^\\bibliography%b{}$")
      or trimmed:match("^\\printbibliography")
    then
      return {}
    end
  end
  return el
end

function RawInline(el)
  if el.format == "latex" or el.format == "tex" then
    local trimmed = el.text:gsub("^%s+", ""):gsub("%s+$", "")
    if trimmed == "\\noindent" or trimmed == "\\centering" or trimmed == "\\hfill" then
      return {}
    end
  end
  return el
end
