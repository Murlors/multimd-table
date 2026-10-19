//! 原生诊断：同一语料、同一核心；时间测量不启用分配计数，避免原子计数污染。
use multimd_table_core::{core, wire::Output};
use std::alloc::{GlobalAlloc, Layout, System};
use std::hint::black_box;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed};
use std::time::{Duration, Instant};

struct Counting;
static COUNTING: AtomicBool = AtomicBool::new(false);
static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
static BYTES: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if COUNTING.load(Relaxed) {
            ALLOCATIONS.fetch_add(1, Relaxed);
            BYTES.fetch_add(layout.size(), Relaxed);
        }
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if COUNTING.load(Relaxed) {
            ALLOCATIONS.fetch_add(1, Relaxed);
            BYTES.fetch_add(size, Relaxed);
        }
        unsafe { System.realloc(pointer, layout, size) }
    }
}
#[global_allocator]
static ALLOCATOR: Counting = Counting;

fn measure(name: &str, mut operation: impl FnMut()) {
    let until = Instant::now() + Duration::from_millis(200);
    while Instant::now() < until {
        operation();
    }
    let mut count = 1;
    loop {
        let start = Instant::now();
        for _ in 0..count {
            operation();
        }
        if start.elapsed() >= Duration::from_millis(5) || count >= 65536 {
            break;
        }
        count *= 2;
    }
    let mut samples = Vec::new();
    for _ in 0..7 {
        let start = Instant::now();
        for _ in 0..count {
            operation();
        }
        samples.push(start.elapsed().as_secs_f64() * 1000.0 / count as f64);
    }
    ALLOCATIONS.store(0, Relaxed);
    BYTES.store(0, Relaxed);
    COUNTING.store(true, Relaxed);
    operation();
    COUNTING.store(false, Relaxed);
    println!(
        "{{\"stage\":\"{name}\",\"samples\":{samples:?},\"allocations\":{},\"allocatedBytes\":{}}}",
        ALLOCATIONS.load(Relaxed),
        BYTES.load(Relaxed),
    );
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let bytes = std::fs::read(&args[1]).unwrap();
    let source: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let options = core::Options(args[2].parse().unwrap());
    let scanner = core::scan_table(&source, options);
    let table = scanner.finish();
    measure("scan", || {
        black_box(core::scan_table(black_box(&source), options));
    });
    measure("model", || {
        black_box(scanner.finish());
    });
    measure("encode", || {
        let mut output = Output::new();
        output.compact_table(black_box(&table));
        black_box(output);
    });
    measure("rust", || {
        black_box(core::parse_table(black_box(&source), options));
    });
    measure("rustWire", || {
        let mut output = Output::new();
        output.compact_table(&core::parse_table(black_box(&source), options));
        black_box(output);
    });
}
