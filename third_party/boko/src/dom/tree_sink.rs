//! html5ever TreeSink implementation for ArenaDom.

use std::cell::{Cell, RefCell};

use html5ever::tendril::StrTendril;
use html5ever::tree_builder::{ElementFlags, NodeOrText, QuirksMode, TreeSink};
use html5ever::{Attribute as Html5Attribute, QualName};

use super::arena::{ArenaDom, ArenaNodeData, ArenaNodeId, Attribute};
use super::{
    MAX_DOCUMENT_ATTRIBUTE_BYTES, MAX_DOCUMENT_ATTRIBUTES, MAX_DOCUMENT_DOM_NODES,
    MAX_DOCUMENT_RETAINED_TEXT_BYTES,
};

/// Handle used by TreeSink to reference nodes.
///
/// Stores the element's `QualName` inline rather than behind an `Rc`:
/// `QualName` is three atoms (word-sized, and static for HTML names), so
/// cloning it is cheaper than allocating an `Rc` per created element.
#[derive(Debug, Clone)]
pub struct NodeHandle {
    pub id: ArenaNodeId,
    name: Option<QualName>,
}

impl PartialEq for NodeHandle {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}

impl Eq for NodeHandle {}

impl Default for NodeHandle {
    fn default() -> Self {
        NodeHandle {
            id: ArenaNodeId::NONE,
            name: None,
        }
    }
}

/// TreeSink implementation that builds an ArenaDom.
///
/// Uses interior mutability (RefCell) because html5ever's TreeSink trait
/// requires methods to take `&self` but we need to mutate the DOM.
pub struct ArenaSink {
    dom: RefCell<ArenaDom>,
    quirks_mode: RefCell<QuirksMode>,
    limits_enabled: bool,
    attribute_count: Cell<usize>,
    attribute_bytes: Cell<usize>,
    retained_text_bytes: Cell<usize>,
    limit_failure: RefCell<Option<String>>,
}

impl Default for ArenaSink {
    fn default() -> Self {
        Self::new()
    }
}

impl ArenaSink {
    pub fn new() -> Self {
        Self {
            dom: RefCell::new(ArenaDom::new()),
            quirks_mode: RefCell::new(QuirksMode::NoQuirks),
            limits_enabled: false,
            attribute_count: Cell::new(0),
            attribute_bytes: Cell::new(0),
            retained_text_bytes: Cell::new(0),
            limit_failure: RefCell::new(None),
        }
    }

    /// Create a sink that refuses DOM allocations beyond the browser import
    /// envelope. The unbounded constructor remains available for boko's
    /// low-level compiler API; all ebook importers use this bounded form.
    pub(crate) fn limited() -> Self {
        Self {
            limits_enabled: true,
            ..Self::new()
        }
    }

    /// Consume the sink and return the DOM.
    pub fn into_dom(self) -> ArenaDom {
        self.dom.into_inner()
    }

    /// Consume a bounded sink, returning its deterministic limit failure
    /// instead of a partially built DOM.
    pub(crate) fn try_into_dom(self) -> crate::Result<ArenaDom> {
        if let Some(context) = self.limit_failure.into_inner() {
            return Err(crate::Error::ResourceLimit { context });
        }
        Ok(self.dom.into_inner())
    }

    fn failed(&self) -> bool {
        self.limit_failure.borrow().is_some()
    }

    fn fail(&self, context: String) {
        let mut failure = self.limit_failure.borrow_mut();
        if failure.is_none() {
            *failure = Some(context);
        }
    }

    /// Reserve one node before the arena vector can grow.
    fn reserve_node(&self) -> bool {
        if !self.limits_enabled {
            return true;
        }
        if self.failed() {
            return false;
        }
        if self.dom.borrow().len() >= MAX_DOCUMENT_DOM_NODES {
            self.fail(format!(
                "document DOM node count exceeds the {MAX_DOCUMENT_DOM_NODES} node limit"
            ));
            return false;
        }
        true
    }

    /// Reserve attributes before converting their tendrils into retained
    /// Strings and before growing any element attribute vector.
    fn reserve_attributes(&self, attrs: &[Html5Attribute]) -> bool {
        if !self.limits_enabled {
            return true;
        }
        if self.failed() {
            return false;
        }
        let Some(next_count) = self.attribute_count.get().checked_add(attrs.len()) else {
            self.fail("document attribute count overflows".into());
            return false;
        };
        if next_count > MAX_DOCUMENT_ATTRIBUTES {
            self.fail(format!(
                "document attribute count exceeds the {MAX_DOCUMENT_ATTRIBUTES} attribute limit"
            ));
            return false;
        }
        let added_bytes = attrs.iter().try_fold(0usize, |total, attr| {
            let prefix_len = attr
                .name
                .prefix
                .as_ref()
                .map_or(0, |prefix| prefix.as_ref().len());
            total
                .checked_add(prefix_len)
                .and_then(|n| n.checked_add(attr.name.local.as_ref().len()))
                .and_then(|n| n.checked_add(attr.value.len()))
        });
        let Some(next_bytes) =
            added_bytes.and_then(|added| self.attribute_bytes.get().checked_add(added))
        else {
            self.fail("document attribute byte length overflows".into());
            return false;
        };
        if next_bytes > MAX_DOCUMENT_ATTRIBUTE_BYTES {
            self.fail(format!(
                "document attribute data exceeds the {MAX_DOCUMENT_ATTRIBUTE_BYTES} byte limit"
            ));
            return false;
        }
        self.attribute_count.set(next_count);
        self.attribute_bytes.set(next_bytes);
        true
    }

    /// Reserve retained character data before a DOM String can grow.
    fn reserve_text(&self, bytes: usize) -> bool {
        if !self.limits_enabled {
            return true;
        }
        if self.failed() {
            return false;
        }
        let Some(next) = self.retained_text_bytes.get().checked_add(bytes) else {
            self.fail("document retained text length overflows".into());
            return false;
        };
        if next > MAX_DOCUMENT_RETAINED_TEXT_BYTES {
            self.fail(format!(
                "document retained text exceeds the {MAX_DOCUMENT_RETAINED_TEXT_BYTES} byte limit"
            ));
            return false;
        }
        self.retained_text_bytes.set(next);
        true
    }

    fn append_text_checked(&self, parent: ArenaNodeId, text: &str) {
        if self.failed() || !self.reserve_text(text.len()) {
            return;
        }
        let needs_node = {
            let dom = self.dom.borrow();
            let last = dom
                .get(parent)
                .map(|node| node.last_child)
                .unwrap_or(ArenaNodeId::NONE);
            !matches!(
                dom.get(last).map(|node| &node.data),
                Some(ArenaNodeData::Text(_))
            )
        };
        if needs_node && !self.reserve_node() {
            return;
        }
        self.dom.borrow_mut().append_text(parent, text);
    }
}

impl TreeSink for ArenaSink {
    type Handle = NodeHandle;
    type Output = Self;
    type ElemName<'a>
        = &'a QualName
    where
        Self: 'a;

    fn finish(self) -> Self::Output {
        self
    }

    fn parse_error(&self, _msg: std::borrow::Cow<'static, str>) {
        // Ignore parse errors - be lenient like browsers
    }

    fn get_document(&self) -> Self::Handle {
        NodeHandle {
            id: self.dom.borrow().document(),
            name: None,
        }
    }

    fn elem_name<'a>(&'a self, target: &'a Self::Handle) -> Self::ElemName<'a> {
        static EMPTY: QualName = QualName {
            prefix: None,
            ns: html5ever::ns!(),
            local: html5ever::local_name!(""),
        };

        target.name.as_ref().unwrap_or(&EMPTY)
    }

    fn create_element(
        &self,
        name: QualName,
        attrs: Vec<Html5Attribute>,
        _flags: ElementFlags,
    ) -> Self::Handle {
        if !self.reserve_node() || !self.reserve_attributes(&attrs) {
            return NodeHandle {
                id: ArenaNodeId::NONE,
                name: Some(name),
            };
        }
        let converted_attrs: Vec<Attribute> = attrs
            .into_iter()
            .map(|a| Attribute {
                name: a.name,
                value: a.value.to_string(),
            })
            .collect();

        let handle_name = name.clone();
        let id = self.dom.borrow_mut().create_element(name, converted_attrs);
        NodeHandle {
            id,
            name: Some(handle_name),
        }
    }

    fn create_comment(&self, text: StrTendril) -> Self::Handle {
        if !self.reserve_node() || !self.reserve_text(text.len()) {
            return NodeHandle::default();
        }
        let id = self.dom.borrow_mut().create_comment(text.to_string());
        NodeHandle { id, name: None }
    }

    fn create_pi(&self, _target: StrTendril, _data: StrTendril) -> Self::Handle {
        // Processing instructions - create as comment
        if !self.reserve_node() {
            return NodeHandle::default();
        }
        let id = self.dom.borrow_mut().create_comment(String::new());
        NodeHandle { id, name: None }
    }

    fn append(&self, parent: &Self::Handle, child: NodeOrText<Self::Handle>) {
        if self.failed() {
            return;
        }
        match child {
            NodeOrText::AppendNode(node) => {
                self.dom.borrow_mut().append(parent.id, node.id);
            }
            NodeOrText::AppendText(text) => {
                self.append_text_checked(parent.id, &text);
            }
        }
    }

    fn append_based_on_parent_node(
        &self,
        element: &Self::Handle,
        prev_element: &Self::Handle,
        child: NodeOrText<Self::Handle>,
    ) {
        if self.failed() {
            return;
        }
        // If element has parent, append there; otherwise use prev_element
        let parent = self.dom.borrow().get(element.id).map(|n| n.parent);
        if let Some(parent) = parent
            && parent.is_some()
        {
            match child {
                NodeOrText::AppendNode(node) => {
                    self.dom.borrow_mut().append(parent, node.id);
                }
                NodeOrText::AppendText(text) => {
                    self.append_text_checked(parent, &text);
                }
            }
            return;
        }
        self.append(prev_element, child);
    }

    fn append_doctype_to_document(
        &self,
        name: StrTendril,
        public_id: StrTendril,
        system_id: StrTendril,
    ) {
        if !self.reserve_node()
            || !self.reserve_text(name.len() + public_id.len() + system_id.len())
        {
            return;
        }
        let mut dom = self.dom.borrow_mut();
        let doc = dom.document();
        let doctype = dom.create_doctype(
            name.to_string(),
            public_id.to_string(),
            system_id.to_string(),
        );
        dom.append(doc, doctype);
    }

    fn get_template_contents(&self, target: &Self::Handle) -> Self::Handle {
        // For templates, just return the target itself
        // A full implementation would track template contents separately
        target.clone()
    }

    fn same_node(&self, x: &Self::Handle, y: &Self::Handle) -> bool {
        x.id == y.id
    }

    fn set_quirks_mode(&self, mode: QuirksMode) {
        *self.quirks_mode.borrow_mut() = mode;
    }

    fn append_before_sibling(&self, sibling: &Self::Handle, new_node: NodeOrText<Self::Handle>) {
        if self.failed() {
            return;
        }
        let mut dom = self.dom.borrow_mut();
        match new_node {
            NodeOrText::AppendNode(node) => {
                dom.insert_before(sibling.id, node.id);
            }
            NodeOrText::AppendText(text) => {
                drop(dom);
                if !self.reserve_node() || !self.reserve_text(text.len()) {
                    return;
                }
                let mut dom = self.dom.borrow_mut();
                let text_node = dom.create_text(text.to_string());
                dom.insert_before(sibling.id, text_node);
            }
        }
    }

    fn add_attrs_if_missing(&self, target: &Self::Handle, attrs: Vec<Html5Attribute>) {
        if !self.reserve_attributes(&attrs) {
            return;
        }
        let converted: Vec<Attribute> = attrs
            .into_iter()
            .map(|a| Attribute {
                name: a.name,
                value: a.value.to_string(),
            })
            .collect();
        self.dom
            .borrow_mut()
            .add_attrs_if_missing(target.id, converted);
    }

    fn remove_from_parent(&self, target: &Self::Handle) {
        if self.failed() {
            return;
        }
        let mut dom = self.dom.borrow_mut();

        let (parent, prev, next) = {
            let node = match dom.get(target.id) {
                Some(n) => n,
                None => return,
            };
            (node.parent, node.prev_sibling, node.next_sibling)
        };

        // Update prev sibling's next pointer
        if prev.is_some() {
            if let Some(p) = dom.get_mut(prev) {
                p.next_sibling = next;
            }
        } else if parent.is_some() {
            // Was first child
            if let Some(p) = dom.get_mut(parent) {
                p.first_child = next;
            }
        }

        // Update next sibling's prev pointer
        if next.is_some() {
            if let Some(n) = dom.get_mut(next) {
                n.prev_sibling = prev;
            }
        } else if parent.is_some() {
            // Was last child
            if let Some(p) = dom.get_mut(parent) {
                p.last_child = prev;
            }
        }

        // Clear the removed node's links
        if let Some(target_node) = dom.get_mut(target.id) {
            target_node.parent = ArenaNodeId::NONE;
            target_node.prev_sibling = ArenaNodeId::NONE;
            target_node.next_sibling = ArenaNodeId::NONE;
        }
    }

    fn reparent_children(&self, node: &Self::Handle, new_parent: &Self::Handle) {
        if self.failed() {
            return;
        }
        // Collect children first to avoid borrow issues
        let children: Vec<_> = self.dom.borrow().children(node.id).collect();

        {
            let mut dom = self.dom.borrow_mut();
            for child in &children {
                // Remove from old parent
                if let Some(c) = dom.get_mut(*child) {
                    c.parent = ArenaNodeId::NONE;
                    c.prev_sibling = ArenaNodeId::NONE;
                    c.next_sibling = ArenaNodeId::NONE;
                }
            }

            // Clear old parent's children
            if let Some(n) = dom.get_mut(node.id) {
                n.first_child = ArenaNodeId::NONE;
                n.last_child = ArenaNodeId::NONE;
            }
        }

        // Append to new parent
        let mut dom = self.dom.borrow_mut();
        for child in children {
            dom.append(new_parent.id, child);
        }
    }
}

#[cfg(test)]
mod tests {
    use html5ever::QualName;
    use html5ever::driver::ParseOpts;
    use html5ever::local_name;
    use html5ever::ns;
    use html5ever::parse_document;
    use html5ever::tendril::TendrilSink;

    use super::*;

    fn parse_html(html: &str) -> ArenaDom {
        let sink = ArenaSink::new();
        let result = parse_document(sink, ParseOpts::default())
            .from_utf8()
            .one(html.as_bytes());
        result.into_dom()
    }

    #[test]
    fn test_basic_parse() {
        let dom = parse_html("<html><body><p>Hello</p></body></html>");

        // Should have document + html + head + body + p + text
        assert!(dom.len() > 3);

        // Find the p element
        let p = dom.find_by_tag("p").expect("should find p");
        assert_eq!(dom.element_name(p).unwrap().as_ref(), "p");

        // Check text content
        let text_id = dom.children(p).next().expect("p should have child");
        assert_eq!(dom.text_content(text_id), Some("Hello"));
    }

    #[test]
    fn test_attributes() {
        let dom = parse_html(r#"<div id="main" class="container header">Content</div>"#);

        let div = dom.find_by_tag("div").expect("should find div");
        assert_eq!(dom.element_id(div), Some("main"));

        let classes: Vec<&str> = dom.element_classes(div).collect();
        assert!(classes.contains(&"container"));
        assert!(classes.contains(&"header"));
    }

    #[test]
    fn test_nested_structure() {
        let dom = parse_html(
            r#"
            <div>
                <p>First</p>
                <p>Second</p>
            </div>
        "#,
        );

        let div = dom.find_by_tag("div").expect("should find div");
        let children: Vec<_> = dom.children(div).collect();

        // Should have two p children (whitespace text nodes may also exist)
        let p_children: Vec<_> = children
            .iter()
            .filter(|&&c| dom.element_name(c).is_some_and(|n| n.as_ref() == "p"))
            .collect();
        assert_eq!(p_children.len(), 2);
    }

    #[test]
    fn foster_parented_text_uses_the_same_pre_retention_budget() {
        let sink = ArenaSink::limited();
        let document = sink.get_document();
        let table_name = QualName::new(None, ns!(html), local_name!("table"));
        let table_id = sink
            .dom
            .borrow_mut()
            .create_element(table_name.clone(), Vec::new());
        sink.dom.borrow_mut().append(document.id, table_id);
        let table = NodeHandle {
            id: table_id,
            name: Some(table_name),
        };

        // `append_based_on_parent_node` is html5ever's foster-parenting path
        // for invalid text inside tables. Seed an exactly-full budget and
        // prove its N+1 append fails before the DOM String or node Vec grows.
        sink.retained_text_bytes
            .set(MAX_DOCUMENT_RETAINED_TEXT_BYTES);
        sink.append_based_on_parent_node(
            &table,
            &document,
            NodeOrText::AppendText(StrTendril::from("x")),
        );

        let error = match sink.try_into_dom() {
            Err(error) => error,
            Ok(_) => panic!("foster text must be bounded"),
        };
        assert!(
            error
                .to_string()
                .contains("document retained text exceeds the 8388608 byte limit")
        );
    }
}
