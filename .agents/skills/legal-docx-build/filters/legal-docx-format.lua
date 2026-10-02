-- Comprehensive Lua filter for legal document DOCX formatting
--
-- Key features:
-- 1. Converts ordered lists to regular paragraphs (legal numbered paragraph style)
-- 2. Converts horizontal rules to page breaks
-- 3. Handles LaTeX page breaks
-- 4. Styles block quotes as italic
-- 5. Removes numbering from third-level headings (###)

-- Remove auto-numbering from third-level headings (subsubsections)
function Header(el)
  if el.level == 3 then
    el.classes:insert("unnumbered")
  end
  return el
end

-- Convert horizontal rules to page breaks
function HorizontalRule(el)
  return pandoc.RawBlock('openxml',
    '<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
end

-- Convert LaTeX page breaks to Word page breaks
function RawBlock(el)
  if el.format == 'latex' or el.format == 'tex' then
    if el.text:match('\\newpage') or el.text:match('\\pagebreak') then
      return pandoc.RawBlock('openxml',
        '<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
    end
  end
  return el
end

-- Style block quotes with italic text
function BlockQuote(el)
  local result = pandoc.walk_block(
    pandoc.Div(el.content),
    {
      Para = function(p)
        return pandoc.Para({pandoc.Emph(p.content)})
      end,
      Plain = function(p)
        return pandoc.Plain({pandoc.Emph(p.content)})
      end
    }
  )
  return pandoc.BlockQuote(result.content)
end

-- Convert bullet lists to regular paragraphs for consistent spacing.
-- The (a), (b), (c) prefixes are already in the text from the python script.
function BulletList(el)
  local blocks = {}
  for _, item in ipairs(el.content) do
    for _, block in ipairs(item) do
      if block.t == "Para" or block.t == "Plain" then
        blocks[#blocks + 1] = pandoc.Para(block.content)
      else
        blocks[#blocks + 1] = block
      end
    end
  end
  return blocks
end

-- Generate the prefix label for a list item based on list style.
-- Decimal → "1.", "2.", etc.  LowerAlpha → "(a)", "(b)", etc.
-- LowerRoman → "(i)", "(ii)", etc.
local function list_label(style, index)
  local letters = "abcdefghijklmnopqrstuvwxyz"
  local romans = {"i","ii","iii","iv","v","vi","vii","viii","ix","x",
                   "xi","xii","xiii","xiv","xv","xvi","xvii","xviii","xix","xx"}
  if style == "LowerAlpha" then
    local ch = index <= #letters and letters:sub(index, index) or tostring(index)
    return "(" .. ch .. ")"
  elseif style == "LowerRoman" then
    local r = index <= #romans and romans[index] or tostring(index)
    return "(" .. r .. ")"
  else
    return tostring(index) .. "."
  end
end

-- Convert ordered lists to regular paragraphs with appropriate prefix.
-- Decimal lists get "1.", "2." etc.  LowerAlpha gets "(a)", "(b)" etc.
-- This ensures all paragraphs use the same Body Text style for consistent spacing.
function OrderedList(el)
  local blocks = {}
  local style = el.listAttributes.style or "Decimal"
  local start = el.listAttributes.start or 1
  for i, item in ipairs(el.content) do
    local idx = start + i - 1
    local lbl = list_label(style, idx)
    for j, block in ipairs(item) do
      if j == 1 and (block.t == "Para" or block.t == "Plain") then
        local prefix = {pandoc.Str(lbl)}
        prefix[#prefix + 1] = pandoc.Space()
        for _, inline in ipairs(block.content) do
          prefix[#prefix + 1] = inline
        end
        blocks[#blocks + 1] = pandoc.Para(prefix)
      else
        blocks[#blocks + 1] = block
      end
    end
  end
  return blocks
end
