//! Checks `limits::approx_heap_bytes` against the bytes a parsed JSON value
//! actually holds on the heap, measured with a counting allocator.
//!
//! Each allocation is counted twice: as its requested size, and as the
//! glibc malloc chunk it takes (`limits::alloc_chunk_bytes`), which is what
//! the estimate models. This file has a single test, so the allocator counts
//! only its allocations.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicIsize, Ordering};

struct Counting;

static LIVE: AtomicIsize = AtomicIsize::new(0);
static LIVE_CHUNKS: AtomicIsize = AtomicIsize::new(0);

fn chunk(size: usize) -> isize {
    selkey_relay::limits::alloc_chunk_bytes(size) as isize
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        LIVE.fetch_add(layout.size() as isize, Ordering::SeqCst);
        LIVE_CHUNKS.fetch_add(chunk(layout.size()), Ordering::SeqCst);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size() as isize, Ordering::SeqCst);
        LIVE_CHUNKS.fetch_sub(chunk(layout.size()), Ordering::SeqCst);
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        LIVE.fetch_add(new_size as isize - layout.size() as isize, Ordering::SeqCst);
        LIVE_CHUNKS.fetch_add(chunk(new_size) - chunk(layout.size()), Ordering::SeqCst);
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// Heap held by `text` once parsed, plus the root `Value` itself: as
/// requested sizes, and as malloc chunks.
fn measured(text: &str) -> (usize, usize, serde_json::Value) {
    let root = std::mem::size_of::<serde_json::Value>();
    let before = (
        LIVE.load(Ordering::SeqCst),
        LIVE_CHUNKS.load(Ordering::SeqCst),
    );
    let value: serde_json::Value = serde_json::from_str(text).unwrap();
    let after = (
        LIVE.load(Ordering::SeqCst),
        LIVE_CHUNKS.load(Ordering::SeqCst),
    );
    let requested = usize::try_from(after.0 - before.0).unwrap() + root;
    let chunks = usize::try_from(after.1 - before.1).unwrap() + root;
    (requested, chunks, value)
}

fn repeat_array(item: &str, body_bytes: usize) -> String {
    let n = body_bytes / (item.len() + 1);
    format!("[{}]", vec![item; n].join(","))
}

#[test]
fn heap_estimate_tracks_real_allocation() {
    const BODY: usize = 256 * 1024;
    let wide_object = format!(
        "{{{}}}",
        (0..BODY / 12)
            .map(|i| format!("\"{i:x}\":0"))
            .collect::<Vec<_>>()
            .join(",")
    );
    let wide_object_reversed = format!(
        "{{{}}}",
        (0..BODY / 12)
            .rev()
            .map(|i| format!("\"{i:08x}\":0"))
            .collect::<Vec<_>>()
            .join(",")
    );
    let shapes: Vec<(&str, String)> = vec![
        ("objects {\"a\":0}", repeat_array(r#"{"a":0}"#, BODY)),
        ("objects {\"\":0}", repeat_array(r#"{"":0}"#, BODY)),
        ("empty objects", repeat_array("{}", BODY)),
        ("zeros", repeat_array("0", BODY)),
        ("empty arrays", repeat_array("[]", BODY)),
        ("one-element arrays", repeat_array("[0]", BODY)),
        ("short strings", repeat_array(r#""x""#, BODY)),
        (
            "objects of 12 members",
            repeat_array(
                r#"{"a":0,"b":0,"c":0,"d":0,"e":0,"f":0,"g":0,"h":0,"i":0,"j":0,"k":0,"l":0}"#,
                BODY,
            ),
        ),
        ("wide object", wide_object),
        ("wide object, keys descending", wide_object_reversed),
        ("long string", format!("\"{}\"", "x".repeat(BODY))),
    ];
    // A contract at the size cap, packed with small objects, as the session
    // store holds it (a typed Contract, charged as its re-serialised JSON).
    for item in [r#"{"":0}"#, r#"{"a":0}"#] {
        let padding = repeat_array(item, selkey_relay::limits::MAX_CONTRACT_BYTES - 256);
        let contract_text = format!(
            r#"{{"purpose_code":"MEDIATION","output_schema_id":"s","output_schema":{{"enum":{padding}}},"participants":["alice","bob"],"prompt_template_hash":"{}"}}"#,
            "a".repeat(64)
        );
        assert!(contract_text.len() <= selkey_relay::limits::MAX_CONTRACT_BYTES);
        let before = LIVE_CHUNKS.load(Ordering::SeqCst);
        // The relay parses the request, then converts the value (consumed).
        let parsed: serde_json::Value = serde_json::from_str(&contract_text).unwrap();
        let contract: selkey_relay::types::Contract = serde_json::from_value(parsed).unwrap();
        let after = LIVE_CHUNKS.load(Ordering::SeqCst);
        let real = usize::try_from(after - before).unwrap() + std::mem::size_of_val(&contract);
        let estimate = selkey_relay::limits::contract_heap_bytes(&contract);
        eprintln!(
            "contract of {item}: text {}, chunks {real}, estimate {estimate}",
            contract_text.len()
        );
        assert!(
            estimate >= real,
            "contract of {item}: estimate {estimate} < real {real}"
        );
        drop(contract);
    }

    for (name, text) in shapes {
        let (requested, chunks, value) = measured(&text);
        let estimate = selkey_relay::limits::approx_heap_bytes(&value);
        let ratio = estimate as f64 / chunks as f64;
        eprintln!(
            "{name}: text {}, requested {requested}, chunks {chunks}, estimate {estimate}, \
             estimate/chunks {ratio:.2}",
            text.len()
        );
        // Never below the real allocation, and not wildly above it.
        assert!(
            estimate >= chunks,
            "{name}: estimate {estimate} < real {chunks}"
        );
        assert!(ratio <= 2.0, "{name}: estimate {estimate} vs real {chunks}");
    }
}
