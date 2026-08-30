//! Pass 3: List Fuser (Fragmented List Repair)

use crate::model::{Chapter, NodeId, Role};

use super::pass::walk_bottom_up;
use super::predicates::has_semantic_attrs;

/// Fuse adjacent lists of the same type.
///
/// Converters often emit a separate `<ul>` for every `<li>`:
/// ```html
/// <ul><li>Item 1</li></ul>
/// <ul><li>Item 2</li></ul>
/// ```
///
/// This looks fine in browsers but breaks:
/// - Ordered list numbering (resets each time)
/// - Margins (double spacing between items)
/// - Semantic structure
///
/// We fuse adjacent lists by moving children from the second list to the first.
pub fn fuse_lists(chapter: &mut Chapter) {
    walk_bottom_up(chapter, |chapter, parent_id| {
        fuse_list_siblings(chapter, parent_id);
    });
}

fn fuse_list_siblings(chapter: &mut Chapter, parent_id: NodeId) {
    let mut cursor_opt = chapter.node(parent_id).and_then(|n| n.first_child);
    // Tail (last child) of the current cursor list, cached across consecutive
    // fusions into the same left list so the one-ul-per-li pattern fuses in
    // O(m) instead of re-walking the growing left list per fusion.
    let mut cached_tail: Option<NodeId> = None;

    while let Some(current_id) = cursor_opt {
        let next_opt = chapter.node(current_id).and_then(|n| n.next_sibling);

        if let Some(next_id) = next_opt
            && can_fuse_lists(chapter, current_id, next_id)
        {
            cached_tail = fuse_list_pair(chapter, current_id, next_id, cached_tail);
            // Don't advance - check if new next is also fuseable
            continue;
        }

        cached_tail = None;
        cursor_opt = next_opt;
    }
}

/// Check if two adjacent nodes are lists that can be fused.
fn can_fuse_lists(chapter: &Chapter, left_id: NodeId, right_id: NodeId) -> bool {
    let (left, right) = match (chapter.node(left_id), chapter.node(right_id)) {
        (Some(l), Some(r)) => (l, r),
        _ => return false,
    };

    // Must be same list type
    if !matches!(
        (left.role, right.role),
        (Role::OrderedList, Role::OrderedList) | (Role::UnorderedList, Role::UnorderedList)
    ) {
        return false;
    }

    // Must have the same style: fusing lists with different presentation
    // would silently change how the survivor's items render.
    if left.style != right.style {
        return false;
    }

    // Neither may carry semantic attributes (mirrors merge.rs): an id= is a
    // link target that would dangle, and ol@start (list_start) encodes
    // numbering that fusing would destroy.
    if has_semantic_attrs(chapter, left_id) || has_semantic_attrs(chapter, right_id) {
        return false;
    }

    true
}

/// Fuse two adjacent lists by moving children from right to left.
///
/// `left_tail` is the cached last child of the left list, if known from a
/// previous fusion into the same list. Returns the new tail of the left list
/// so consecutive fusions avoid re-walking its children.
fn fuse_list_pair(
    chapter: &mut Chapter,
    left_id: NodeId,
    right_id: NodeId,
    left_tail: Option<NodeId>,
) -> Option<NodeId> {
    // Get right's children
    let right_first = chapter.node(right_id).and_then(|n| n.first_child);

    let right_next = chapter.node(right_id).and_then(|n| n.next_sibling);

    if right_first.is_none() {
        // Right list is empty, just unlink it
        if let Some(left_node) = chapter.node_mut(left_id) {
            left_node.next_sibling = right_next;
        }
        return left_tail;
    }

    // 1. Reparent all children of right to left, remembering the last one.
    let mut right_last = None;
    let mut child_opt = right_first;
    while let Some(child_id) = child_opt {
        let next_child = chapter.node(child_id).and_then(|n| n.next_sibling);
        if let Some(child_node) = chapter.node_mut(child_id) {
            child_node.parent = Some(left_id);
        }
        right_last = Some(child_id);
        child_opt = next_child;
    }

    // 2. Find left's last child (use the cached tail when available).
    let left_last = left_tail.or_else(|| {
        let mut current_opt = chapter.node(left_id).and_then(|n| n.first_child);
        while let Some(current) = current_opt {
            let next = chapter.node(current).and_then(|n| n.next_sibling);
            if next.is_none() {
                return Some(current);
            }
            current_opt = next;
        }
        None
    });

    // 3. Stitch: left_last.next_sibling = right_first
    if let Some(last_id) = left_last {
        if let Some(last_node) = chapter.node_mut(last_id) {
            last_node.next_sibling = right_first;
        }
    } else {
        // Left was empty, right's children become left's children
        if let Some(left_node) = chapter.node_mut(left_id) {
            left_node.first_child = right_first;
        }
    }

    // 4. Unlink right from sibling chain
    if let Some(left_node) = chapter.node_mut(left_id) {
        left_node.next_sibling = right_next;
        left_node.last_child = right_last;
    }

    right_last
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Node;

    #[test]
    fn test_fuse_adjacent_unordered_lists() {
        let mut chapter = Chapter::new();

        let ul1 = chapter.alloc_node(Node::new(Role::UnorderedList));
        chapter.append_child(NodeId::ROOT, ul1);

        let li1 = chapter.alloc_node(Node::new(Role::ListItem));
        chapter.append_child(ul1, li1);

        let ul2 = chapter.alloc_node(Node::new(Role::UnorderedList));
        chapter.append_child(NodeId::ROOT, ul2);

        let li2 = chapter.alloc_node(Node::new(Role::ListItem));
        chapter.append_child(ul2, li2);

        assert_eq!(chapter.children(NodeId::ROOT).count(), 2);

        fuse_lists(&mut chapter);

        let root_children: Vec<_> = chapter.children(NodeId::ROOT).collect();
        assert_eq!(root_children.len(), 1);

        let list_children: Vec<_> = chapter.children(root_children[0]).collect();
        assert_eq!(list_children.len(), 2);
    }

    #[test]
    fn test_no_fuse_different_list_types() {
        let mut chapter = Chapter::new();

        let ul = chapter.alloc_node(Node::new(Role::UnorderedList));
        chapter.append_child(NodeId::ROOT, ul);

        let ol = chapter.alloc_node(Node::new(Role::OrderedList));
        chapter.append_child(NodeId::ROOT, ol);

        fuse_lists(&mut chapter);

        assert_eq!(chapter.children(NodeId::ROOT).count(), 2);
    }

    /// Build a list of the given role with one (empty) list item.
    fn list_with_item(chapter: &mut Chapter, role: Role) -> NodeId {
        let list = chapter.alloc_node(Node::new(role));
        chapter.append_child(NodeId::ROOT, list);
        let li = chapter.alloc_node(Node::new(Role::ListItem));
        chapter.append_child(list, li);
        list
    }

    #[test]
    fn no_fuse_when_second_list_has_id() {
        let mut chapter = Chapter::new();
        let _ul1 = list_with_item(&mut chapter, Role::UnorderedList);
        let ul2 = list_with_item(&mut chapter, Role::UnorderedList);
        // The second list is a link target; fusing would destroy the anchor.
        chapter.semantics.set_id(ul2, "target");

        fuse_lists(&mut chapter);

        assert_eq!(chapter.children(NodeId::ROOT).count(), 2);
        assert_eq!(chapter.semantics.id(ul2), Some("target"));
    }

    #[test]
    fn no_fuse_when_ordered_list_has_start() {
        let mut chapter = Chapter::new();
        let _ol1 = list_with_item(&mut chapter, Role::OrderedList);
        let ol2 = list_with_item(&mut chapter, Role::OrderedList);
        // ol@start encodes numbering that fusing would destroy.
        chapter.semantics.set_list_start(ol2, 5);

        fuse_lists(&mut chapter);

        assert_eq!(chapter.children(NodeId::ROOT).count(), 2);
        assert_eq!(chapter.semantics.list_start(ol2), Some(5));
    }

    #[test]
    fn no_fuse_when_styles_differ() {
        use crate::style::{ComputedStyle, FontWeight};

        let mut chapter = Chapter::new();
        let _ul1 = list_with_item(&mut chapter, Role::UnorderedList);
        let ul2 = list_with_item(&mut chapter, Role::UnorderedList);
        let bold = chapter.styles.intern(ComputedStyle {
            font_weight: FontWeight::BOLD,
            ..Default::default()
        });
        if let Some(node) = chapter.node_mut(ul2) {
            node.style = bold;
        }

        fuse_lists(&mut chapter);

        assert_eq!(chapter.children(NodeId::ROOT).count(), 2);
    }

    #[test]
    fn fuses_long_run_of_single_item_lists_in_order() {
        // The one-ul-per-li pattern: many consecutive fusions into the same
        // left list (exercises the cached-tail path).
        let mut chapter = Chapter::new();
        let mut items = Vec::new();
        for _ in 0..8 {
            let ul = chapter.alloc_node(Node::new(Role::UnorderedList));
            chapter.append_child(NodeId::ROOT, ul);
            let li = chapter.alloc_node(Node::new(Role::ListItem));
            chapter.append_child(ul, li);
            items.push(li);
        }

        fuse_lists(&mut chapter);

        let root_children: Vec<_> = chapter.children(NodeId::ROOT).collect();
        assert_eq!(root_children.len(), 1);
        let fused_items: Vec<_> = chapter.children(root_children[0]).collect();
        assert_eq!(fused_items, items, "items preserved in document order");
        for li in &fused_items {
            assert_eq!(
                chapter.node(*li).and_then(|n| n.parent),
                Some(root_children[0])
            );
        }
    }
}
