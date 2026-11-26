-- NovaTeX Academic LaTeX Lua Filter
-- Compatible with BOTH Pandoc 2.12 (Lua 5.3, pandoc-types 1.22) and Pandoc 3.x (Lua 5.4, pandoc-types 1.23)

local cite_mode = "cite"

local function trim(s)
  return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function escape_latex(text)
  local replacements = {
    ["\\"] = "\\textbackslash{}",
    ["{"] = "\\{",
    ["}"] = "\\}",
    ["$"] = "\\$",
    ["&"] = "\\&",
    ["#"] = "\\#",
    ["%"] = "\\%",
    ["_"] = "\\_",
    ["^"] = "\\textasciicircum{}",
    ["~"] = "\\textasciitilde{}",
  }
  return (text:gsub("[\\{}$&#%%_^~]", replacements))
end

local function escape_latex_url(url)
  local replacements = {
    ["\\"] = "\\%5C",
    ["{"] = "\\{",
    ["}"] = "\\}",
    ["%"] = "\\%",
    ["#"] = "\\#",
  }
  return (url:gsub("[\\{}%%#]", replacements))
end

local function escape_latex_graphic_path(src)
  -- Normalize backslashes to POSIX slashes and sanitize TeX-active chars (%, #, {, })
  -- so graphicx \filename@parse never fails with "Missing \endcsname inserted"
  local normalized = src:gsub("\\", "/")
  return (normalized:gsub("[{}%%#]", "_"))
end

local function escape_latex_label(id)
  if not id then
    return ""
  end
  local cleaned = id:gsub("[^%w:%-._/]", "-")
  cleaned = cleaned:gsub("%-+", "-"):gsub("^%-+", ""):gsub("%-+$", "")
  return cleaned
end

local function render_inlines_to_latex(inlines)
  if not inlines then
    return ""
  end
  local out = {}
  for _, el in ipairs(inlines) do
    local t = el.t
    if t == "Str" then
      table.insert(out, escape_latex(el.text))
    elseif t == "Space" or t == "SoftBreak" then
      table.insert(out, " ")
    elseif t == "LineBreak" then
      table.insert(out, " \\newline ")
    elseif t == "Math" then
      if el.mathtype == "DisplayMath" then
        table.insert(out, "$$" .. el.text .. "$$")
      else
        table.insert(out, "$" .. el.text .. "$")
      end
    elseif t == "Emph" then
      table.insert(out, "\\emph{" .. render_inlines_to_latex(el.content) .. "}")
    elseif t == "Strong" then
      table.insert(out, "\\textbf{" .. render_inlines_to_latex(el.content) .. "}")
    elseif t == "Underline" then
      table.insert(out, "\\underline{" .. render_inlines_to_latex(el.content) .. "}")
    elseif t == "Strikeout" then
      table.insert(out, render_inlines_to_latex(el.content))
    elseif t == "Superscript" then
      table.insert(out, "\\textsuperscript{" .. render_inlines_to_latex(el.content) .. "}")
    elseif t == "Subscript" then
      table.insert(out, "\\textsubscript{" .. render_inlines_to_latex(el.content) .. "}")
    elseif t == "Code" then
      table.insert(out, "\\texttt{" .. escape_latex(el.text) .. "}")
    elseif t == "Quoted" then
      local inner = render_inlines_to_latex(el.content)
      if el.quotetype == "SingleQuote" then
        table.insert(out, "`" .. inner .. "'")
      else
        table.insert(out, "``" .. inner .. "''")
      end
    elseif t == "RawInline" then
      if el.format == "latex" or el.format == "tex" then
        table.insert(out, el.text)
      end
    elseif t == "Span" then
      table.insert(out, render_inlines_to_latex(el.content))
    elseif t == "Link" then
      local label = render_inlines_to_latex(el.content)
      if el.target and el.target ~= "" then
        table.insert(out, "\\href{" .. escape_latex_url(el.target) .. "}{" .. label .. "}")
      else
        table.insert(out, label)
      end
    elseif t == "Cite" then
      local keys = {}
      if el.citations then
        for _, c in ipairs(el.citations) do
          if c.id and c.id ~= "" then
            local safe_id = escape_latex_label(c.id)
            if safe_id ~= "" then
              table.insert(keys, safe_id)
            end
          end
        end
      end
      if #keys > 0 then
        table.insert(out, "\\cite{" .. table.concat(keys, ",") .. "}")
      else
        table.insert(out, render_inlines_to_latex(el.content))
      end
    else
      -- Unknown inline inside simple table cell: bail out so native writer handles it
      return nil
    end
  end
  return table.concat(out)
end

local function extract_cell_latex(cell)
  -- Support both Pandoc 2.12+ Cell ({contents = {blocks}}) and legacy block list
  local blocks = cell.contents or cell
  if type(blocks) ~= "table" then
    return nil
  end
  if #blocks == 0 then
    return ""
  end
  local parts = {}
  for _, blk in ipairs(blocks) do
    if blk.t == "Plain" or blk.t == "Para" then
      local rendered = render_inlines_to_latex(blk.content)
      if rendered == nil then
        return nil
      end
      table.insert(parts, trim(rendered))
    else
      -- Complex block inside table cell (nested list/codeblock/table) -> fallback to native writer
      return nil
    end
  end
  return table.concat(parts, " ")
end

local function alignment_to_col(align)
  if align == "AlignRight" then
    return "r"
  elseif align == "AlignCenter" then
    return "c"
  else
    return "l"
  end
end

local function extract_row_cells(row)
  -- Pandoc 2.12: row = {attr, cells}; Pandoc 3.x: row.cells or row[2]
  if row.cells then
    return row.cells
  elseif type(row[2]) == "table" then
    return row[2]
  end
  return nil
end

local function extract_caption_latex(caption)
  if not caption then
    return ""
  end
  local long_cap = caption.long or caption[2]
  if type(long_cap) ~= "table" or #long_cap == 0 then
    return ""
  end
  local parts = {}
  for _, blk in ipairs(long_cap) do
    if blk.t == "Plain" or blk.t == "Para" then
      local rendered = render_inlines_to_latex(blk.content)
      if rendered == nil then
        return nil
      end
      table.insert(parts, trim(rendered))
    else
      return nil
    end
  end
  return trim(table.concat(parts, " "))
end

local function read_meta(meta)
  if meta and meta.novatex_cite_mode then
    cite_mode = pandoc.utils.stringify(meta.novatex_cite_mode)
  end
  return meta
end

local function filter_math(el)
  if el.mathtype == "DisplayMath" then
    local body = trim(el.text)
    return pandoc.RawInline("latex", "$$\n" .. body .. "\n$$")
  else
    return pandoc.RawInline("latex", "$" .. el.text .. "$")
  end
end

local function filter_cite(el)
  if cite_mode ~= "cite" then
    return el
  end
  if not el.citations or #el.citations == 0 then
    return el
  end
  local keys = {}
  for _, c in ipairs(el.citations) do
    local has_prefix = c.prefix and #c.prefix > 0
    local has_suffix = c.suffix and #c.suffix > 0
    if c.mode ~= "NormalCitation" or has_prefix or has_suffix then
      -- Let Pandoc's --natbib / --biblatex handle complex citations
      return el
    end
    local safe_id = escape_latex_label(c.id)
    if safe_id == "" then
      return el
    end
    table.insert(keys, safe_id)
  end
  return pandoc.RawInline("latex", "\\cite{" .. table.concat(keys, ",") .. "}")
end

-- Convert tight Plain list items to Para so Pandoc never injects undefined \tightlist
local function untighten_list_items(items)
  for i, item in ipairs(items) do
    for j, blk in ipairs(item) do
      if blk.t == "Plain" then
        item[j] = pandoc.Para(blk.content)
      end
    end
    items[i] = item
  end
  return items
end

local function filter_bullet_list(el)
  el.content = untighten_list_items(el.content)
  return el
end

local function filter_ordered_list(el)
  el.content = untighten_list_items(el.content)
  return el
end

local VALID_TEX_UNITS = {
  ["in"] = true,
  ["cm"] = true,
  ["mm"] = true,
  ["pt"] = true,
  ["bp"] = true,
  ["pc"] = true,
  ["em"] = true,
  ["ex"] = true,
}

local VALID_TEX_MACROS = {
  ["linewidth"] = true,
  ["textwidth"] = true,
  ["columnwidth"] = true,
  ["textheight"] = true,
}

local function normalize_latex_dim(val, axis)
  if not val or val == "" then
    return nil
  end
  local trimmed = trim(val)
  -- Convert percentage like "80%" -> "0.80\linewidth" (or "\textheight")
  local pct = trimmed:match("^([%d%.]+)%%$")
  if pct then
    local num = tonumber(pct)
    if num and num > 0 then
      local ratio = math.min(num / 100.0, 1.0)
      local base = axis == "height" and "\\textheight" or "\\linewidth"
      return string.format("%.2f%s", ratio, base)
    end
  end
  -- Convert px -> pt (approx 0.75pt per px at 96dpi)
  local px = trimmed:match("^([%d%.]+)px$")
  if px then
    local num = tonumber(px)
    if num and num > 0 then
      return string.format("%.1fpt", num * 0.75)
    end
  end
  -- Pass through valid TeX units (in, cm, mm, pt, bp, pc, em, ex)
  local num_part, unit_part = trimmed:match("^([%d%.]+)%s*([a-z]+)$")
  if num_part and unit_part and VALID_TEX_UNITS[unit_part] and tonumber(num_part) then
    return num_part .. unit_part
  end
  -- Pass through TeX macro lengths (\linewidth, \textwidth, \columnwidth, \textheight)
  local coef, macro = trimmed:match("^([%d%.]*)\\([a-z]+)$")
  if macro and VALID_TEX_MACROS[macro] then
    return coef .. "\\" .. macro
  end
  return nil
end

local function build_includegraphics_opt(attrs)
  local width = normalize_latex_dim(attrs and attrs["width"] or nil, "width")
  local height = normalize_latex_dim(attrs and attrs["height"] or nil, "height")
  if not width and not height then
    return "width=0.85\\linewidth"
  end
  local opts = {}
  if width then
    table.insert(opts, "width=" .. width)
  end
  if height then
    table.insert(opts, "height=" .. height)
  end
  return table.concat(opts, ",")
end

local function render_figure_block(src, caption_inlines, identifier, attrs)
  local opt = build_includegraphics_opt(attrs)
  local caption_tex = ""
  if caption_inlines and #caption_inlines > 0 then
    local rendered = render_inlines_to_latex(caption_inlines)
    if rendered ~= nil then
      caption_tex = trim(rendered)
    end
  end
  local safe_src = escape_latex_graphic_path(src)
  local safe_label = escape_latex_label(identifier)
  local lines = {
    "\\begin{figure}[htbp]",
    "\\centering",
    "\\includegraphics[" .. opt .. "]{" .. safe_src .. "}",
  }
  if caption_tex ~= "" then
    table.insert(lines, "\\caption{" .. caption_tex .. "}")
  end
  if safe_label ~= "" then
    table.insert(lines, "\\label{" .. safe_label .. "}")
  end
  table.insert(lines, "\\end{figure}")
  return pandoc.RawBlock("latex", table.concat(lines, "\n"))
end

local function filter_para(el)
  -- Pandoc 2.12 represents standalone captioned figures as Para({ Image })
  if #el.content == 1 and el.content[1].t == "Image" then
    local img = el.content[1]
    local has_caption = img.caption and #img.caption > 0
    local is_fig_title = img.title and img.title:sub(1, 4) == "fig:"
    if has_caption or is_fig_title then
      return render_figure_block(img.src, img.caption, img.identifier, img.attributes)
    end
  end
  return el
end

local function filter_figure(el)
  -- Pandoc 3.x dedicated Figure block support
  local img = nil
  if el.content then
    for _, blk in ipairs(el.content) do
      if (blk.t == "Plain" or blk.t == "Para") and blk.content then
        for _, inl in ipairs(blk.content) do
          if inl.t == "Image" then
            img = inl
            break
          end
        end
      end
      if img then break end
    end
  end
  if not img then
    return el
  end
  local caption_inlines = nil
  if el.caption and el.caption.long and #el.caption.long > 0 then
    local first_blk = el.caption.long[1]
    if first_blk and (first_blk.t == "Plain" or first_blk.t == "Para") then
      caption_inlines = first_blk.content
    end
  end
  if (not caption_inlines or #caption_inlines == 0) and img.caption and #img.caption > 0 then
    caption_inlines = img.caption
  end
  local id = (el.identifier and el.identifier ~= "") and el.identifier or img.identifier
  return render_figure_block(img.src, caption_inlines, id, img.attributes)
end

local function filter_image(el)
  local attrs = el.attributes or {}
  local has_width = attrs["width"] ~= nil and attrs["width"] ~= ""
  local has_height = attrs["height"] ~= nil and attrs["height"] ~= ""
  if not has_width and not has_height then
    return pandoc.RawInline("latex", "\\includegraphics[width=0.85\\linewidth]{" .. escape_latex_graphic_path(el.src) .. "}")
  end
  return el
end

local function filter_table(el)
  -- Convert simple academic tables to clean booktabs tabular inside table environment
  -- Fall back to native Pandoc writer if structure is complex or too tall
  local colspecs = el.colspecs
  if type(colspecs) ~= "table" or #colspecs == 0 then
    return el
  end

  local col_aligns = {}
  for _, spec in ipairs(colspecs) do
    local align = spec[1]
    table.insert(col_aligns, alignment_to_col(align))
  end

  local head_rows = {}
  if el.head then
    local raw_head_rows = el.head.rows or el.head[2]
    if type(raw_head_rows) == "table" then
      for _, row in ipairs(raw_head_rows) do
        local cells = extract_row_cells(row)
        if not cells then return el end
        local rendered_row = {}
        for _, cell in ipairs(cells) do
          local col_span = cell.col_span or 1
          local row_span = cell.row_span or 1
          if col_span ~= 1 or row_span ~= 1 then return el end
          local txt = extract_cell_latex(cell)
          if txt == nil then return el end
          table.insert(rendered_row, txt)
        end
        table.insert(head_rows, table.concat(rendered_row, " & ") .. " \\\\")
      end
    end
  end

  local body_rows = {}
  if type(el.bodies) == "table" then
    for _, body in ipairs(el.bodies) do
      local raw_rows = body.body or body[4]
      if type(raw_rows) == "table" then
        for _, row in ipairs(raw_rows) do
          local cells = extract_row_cells(row)
          if not cells then return el end
          local rendered_row = {}
          for _, cell in ipairs(cells) do
            local col_span = cell.col_span or 1
            local row_span = cell.row_span or 1
            if col_span ~= 1 or row_span ~= 1 then return el end
            local txt = extract_cell_latex(cell)
            if txt == nil then return el end
            table.insert(rendered_row, txt)
          end
          table.insert(body_rows, table.concat(rendered_row, " & ") .. " \\\\")
        end
      end
    end
  end

  -- Guard against giant multi-page tables (let longtable handle > 40 rows)
  if #body_rows > 40 then
    return el
  end

  local caption_text = extract_caption_latex(el.caption)
  if caption_text == nil then
    return el
  end

  local lines = {}
  table.insert(lines, "\\begin{table}[htbp]")
  table.insert(lines, "\\centering")
  if caption_text ~= "" then
    table.insert(lines, "\\caption{" .. caption_text .. "}")
  end
  local safe_label = escape_latex_label(el.identifier)
  if safe_label ~= "" then
    table.insert(lines, "\\label{" .. safe_label .. "}")
  end
  table.insert(lines, "\\begin{tabular}{" .. table.concat(col_aligns, "") .. "}")
  table.insert(lines, "\\toprule")
  for _, r in ipairs(head_rows) do
    table.insert(lines, r)
  end
  if #head_rows > 0 and #body_rows > 0 then
    table.insert(lines, "\\midrule")
  end
  for _, r in ipairs(body_rows) do
    table.insert(lines, r)
  end
  table.insert(lines, "\\bottomrule")
  table.insert(lines, "\\end{tabular}")
  table.insert(lines, "\\end{table}")

  return pandoc.RawBlock("latex", table.concat(lines, "\n"))
end

-- Unwrap generic Div containers so Pandoc does not leak raw LaTeX/HTML wrappers
local function filter_div(el)
  if el.identifier == "" and (#el.classes == 0 or (el.classes[1] == "center")) then
    return el.content
  end
  return el
end

return {
  { Meta = read_meta },
  {
    Para = filter_para,
    Figure = filter_figure,
  },
  {
    Math = filter_math,
    Cite = filter_cite,
    BulletList = filter_bullet_list,
    OrderedList = filter_ordered_list,
    Image = filter_image,
    Table = filter_table,
    Div = filter_div,
  },
}
