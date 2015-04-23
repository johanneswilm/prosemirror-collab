import {Pos, Node, inline, slice} from "../model"

import {defineStep, Result, Step, Transform} from "./transform"
import {PosMap, MovedRange, ReplacedRange} from "./map"
import {copyTo} from "./tree"

function samePathDepth(a, b) {
  for (let i = 0;; i++)
    if (i == a.path.length || i == b.path.length || a.path[i] != b.path[i])
      return i
}

function sizeBefore(node, at) {
  if (node.type.block) {
    let size = 0
    for (let i = 0; i < at; i++) size += node.content[i].size
    return size
  } else {
    return at
  }
}

export function replace(doc, from, to, root, repl) {
  let origParent = doc.path(root)
  if (repl.nodes.length && repl.nodes[0].type.type != origParent.type.contains)
    return null

  let copy = copyTo(doc, root)
  let parent = copy.path(root)
  parent.content.length = 0
  let depth = root.length

  let fromEnd = depth == from.path.length
  let start = fromEnd ? from.offset : from.path[depth]
  parent.pushNodes(origParent.slice(0, start))
  if (!fromEnd) {
    parent.push(slice.before(origParent.content[start], from, depth + 1))
    ++start
  } else {
    start = parent.content.length
  }
  parent.pushNodes(repl.nodes)
  let end
  if (depth == to.path.length) {
    end = to.offset
  } else {
    let n = to.path[depth]
    parent.push(slice.after(origParent.content[n], to, depth + 1))
    end = n + 1
  }
  parent.pushNodes(origParent.slice(end))

  var moved = []

  let rightEdge = start + repl.nodes.length, startLen = parent.content.length
  if (repl.nodes.length)
    mendLeft(parent, start, depth, repl.openLeft)
  mendRight(parent, rightEdge + (parent.content.length - startLen), root,
            repl.nodes.length ? repl.openRight : from.path.length - depth)

  function mendLeft(node, at, depth, open) {
    if (node.type.block)
      return inline.stitchTextNodes(node, at)

    if (open == 0 || depth == from.path.length) return

    let before = node.content[at - 1], after = node.content[at]
    if (before.sameMarkup(after)) {
      let oldSize = before.content.length
      before.pushFrom(after)
      node.content.splice(at, 1)
      mendLeft(before, oldSize, depth + 1, open - 1)
    }
  }

  function addMoved(start, size, dest) {
    if (start.cmp(dest))
      moved.push(new MovedRange(start, size, dest))
  }

  function mendRight(node, at, path, open) {
    let toEnd = path.length == to.path.length
    let after = node.content[at], before

    let sBefore = toEnd ? sizeBefore(node, at) : at + 1
    let movedStart = toEnd ? to : to.shorten(path.length, 1)
    let movedSize = node.maxOffset - sBefore

    if (!toEnd && open > 0 && (before = node.content[at - 1]).sameMarkup(after)) {
      after.content = before.content.concat(after.content)
      node.content.splice(at - 1, 1)
      addMoved(movedStart, movedSize, new Pos(path, sBefore - 1))
      mendRight(after, before.content.length, path.concat(at - 1), open - 1)
    } else {
      if (node.type.block) inline.stitchTextNodes(node, at)
      addMoved(movedStart, movedSize, new Pos(path, sBefore))
      if (!toEnd) mendRight(after, 0, path.concat(at), 0)
    }
  }

  return {doc: copy, moved}
}

const nullRepl = {nodes: [], openLeft: 0, openRight: 0}

defineStep("replace", {
  apply(doc, data) {
    let root = data.pos.path
    if (data.from.path.length < root.length || data.to.path.length < root.length)
      return null
    for (let i = 0; i < root.length; i++)
      if (data.from.path[i] != root[i] || data.to.path[i] != root[i]) return null

    let {doc: out, moved} = replace(doc, data.from, data.to, root, data.param || nullRepl)
    if (!out) return null
    let end = moved.length ? moved[moved.length - 1].dest : data.to
    let replaced = new ReplacedRange(data.from, data.to, data.from, end, data.pos, data.pos)
    return new Result(doc, out, new PosMap(moved, [replaced]))
  },
  invert(result, data) {
    let depth = data.pos.path.length
    let between = slice.between(result.before, data.from, data.to, false)
    for (let i = 0; i < depth; i++) between = between.content[0]
    return new Step("replace", data.from, result.map.mapSimple(data.to), data.from.shorten(depth), {
      nodes: between.content,
      openLeft: data.from.path.length - depth,
      openRight: data.to.path.length - depth
    })
  }
})

function buildInserted(nodesLeft, source, start, end) {
  let sliced = slice.between(source, start, end, false)
  let nodesRight = []
  for (let node = sliced, i = 0; i <= start.path.length; i++, node = node.content[0])
    nodesRight.push(node)
  let same = samePathDepth(start, end)
  let searchLeft = nodesLeft.length - 1, searchRight = nodesRight.length - 1
  let result = null

  let inner = nodesRight[searchRight]
  if (inner.type.block && inner.size && nodesLeft[searchLeft].type.block) {
    result = nodesLeft[searchLeft--].copy(inner.content)
    nodesRight[--searchRight].content.shift()
  }

  for (;;) {
    let node = nodesRight[searchRight], type = node.type, matched = null
    let outside = searchRight <= same
    for (let i = searchLeft; i >= 0; i--) {
      let left = nodesLeft[i]
      if (outside ? left.type.contains == type.contains : left.type == type) {
        matched = i
        break
      }
    }
    if (matched != null) {
      if (!result) {
        result = nodesLeft[matched].copy(node.content)
        searchLeft = matched - 1
      } else {
        while (searchLeft >= matched)
          result = nodesLeft[searchLeft--].copy([result])
        result.pushFrom(node)
      }
    }
    if (matched != null || node.content.length == 0) {
      if (outside) break
      if (searchRight) nodesRight[searchRight - 1].content.shift()
    }
    searchRight--
  }

  let repl = {nodes: result ? result.content : [],
              openLeft: start.path.length - searchRight,
              openRight: end.path.length - searchRight}
  return {repl, depth: searchLeft + 1}
}

function moveText(tr, doc, before, after) {
  let root = samePathDepth(before, after)
  let cutAt = after.shorten(null, 1)
  while (cutAt.path.length > root && doc.path(cutAt.path).content.length == 1)
    cutAt = cutAt.shorten(null, 1)
  tr.split(cutAt, cutAt.path.length - root)
  let start = after, end = new Pos(start.path, doc.path(start.path).maxOffset)
  let parent = doc.path(start.path.slice(0, root))
  let wanted = parent.pathNodes(before.path.slice(root))
  let existing = parent.pathNodes(start.path.slice(root))
  while (wanted.length && existing.length && wanted[0].sameMarkup(existing[0])) {
    wanted.shift()
    existing.shift()
  }
  if (existing.length || wanted.length)
    tr.step("ancestor", start, end, null, {
      depth: existing.length,
      wrappers: wanted.map(n => n.copy())
    })
  for (let i = root; i < before.path.length; i++)
    tr.join(before.shorten(i, 1))
}

Transform.prototype.delete = function(from, to) {
  this.replace(from, to)
  return this
}

Transform.prototype.replace = function(from, to, source, start, end) {
  let repl, depth, doc = this.doc, maxDepth = samePathDepth(from, to)
  if (source) {
    ;({repl, depth}) = buildInserted(doc.pathNodes(from.path), source, start, end)
    while (depth > maxDepth) {
      repl = {nodes: [doc.path(from.path.slice(0, depth)).copy(repl.nodes)],
              openLeft: repl.openLeft + 1, openRight: repl.openRight + 1}
      depth--
    }
  } else {
    repl = nullRepl
    depth = maxDepth
  }
  let root = from.shorten(depth)
  let result = this.step("replace", from, to, root, repl)

  // If no text nodes before or after end of replacement, don't glue text
  if (!doc.path(to.path).type.block) return this
  if (!(repl.nodes.length ? source.path(end.path).type.block : doc.path(from.path).type.block)) return this

  let nodesAfter = doc.path(root.path).pathNodes(to.path.slice(depth)).slice(1)
  let nodesBefore
  if (repl.nodes.length) {
    let inserted = repl.nodes
    nodesBefore = []
    for (let i = 0; i < repl.openRight; i++) {
      let last = inserted[inserted.length - 1]
      nodesBefore.push(last)
      inserted = last.content
    }
  } else {
    nodesBefore = doc.path(root.path).pathNodes(from.path.slice(depth)).slice(1)
  }
  if (nodesAfter.length != nodesBefore.length ||
      !nodesAfter.every((n, i) => n.sameMarkup(nodesBefore[i]))) {
    let after = result.map.mapSimple(to)
    let before = Pos.before(result.doc, after.shorten(null, 0))
    moveText(this, result.doc, before, after)
  }
  return this
}

Transform.prototype.insert = function(pos, nodes) {
  if (!Array.isArray(nodes)) nodes = [nodes]
  this.step("replace", pos, pos, pos, {nodes: nodes, openLeft: 0, openRight: 0})
  return this
}

Transform.prototype.insertInline = function(pos, nodes) {
  if (!Array.isArray(nodes)) nodes = [nodes]
  let styles = inline.inlineStylesAt(this.doc, pos)
  let nodes = nodes.map(n => new Node.Inline(n.type, styles, n.text, n.attrs))
  return this.insert(pos, nodes)
}

Transform.prototype.insertText = function(pos, text) {
  return this.insertInline(pos, Node.text(text))
}