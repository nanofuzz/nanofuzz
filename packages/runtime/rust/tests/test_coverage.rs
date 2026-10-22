use nanofuzz_runtime::coverage::{hit_branch, hit_fn, hit_stmt, reset, take_hits, take_multi_hits};

#[test]
fn test_single_file_coverage_recording() {
    reset();

    // File 0 hits
    hit_fn(0, 0);
    hit_stmt(0, 0);
    hit_stmt(0, 1);
    hit_stmt(0, 1); // Hit twice
    hit_branch(0, 0, 1);

    let branch_arms = [(0, 2)];
    let cov = take_hits("src/main.rs", &branch_arms);

    assert_eq!(cov.path, "src/main.rs");
    assert_eq!(cov.f.get("0"), Some(&1));
    assert_eq!(cov.s.get("0"), Some(&1));
    assert_eq!(cov.s.get("1"), Some(&2));
    assert_eq!(cov.s.get("2"), None);

    // Branch arms
    let arms = cov.b.get("0").expect("branch 0 missing");
    assert_eq!(arms.len(), 2);
    assert_eq!(arms[0], 0);
    assert_eq!(arms[1], 1);

    // After take_hits, buffer should be drained
    let empty_cov = take_hits("src/main.rs", &branch_arms);
    assert!(empty_cov.s.is_empty());
    assert!(empty_cov.f.is_empty());
    assert_eq!(empty_cov.b.get("0"), Some(&vec![0, 0]));
}

#[test]
fn test_multi_file_coverage_no_collisions() {
    reset();

    // File 0: src/main.rs
    hit_fn(0, 0);
    hit_stmt(0, 0);
    hit_stmt(0, 5);
    hit_branch(0, 0, 0);

    // File 1: src/helper.rs - using the same indices (0, 0)
    hit_fn(1, 0);
    hit_stmt(1, 0);
    hit_stmt(1, 10);
    hit_branch(1, 0, 1);

    // File 2: vendor/lib.rs - another file with overlapping indices
    hit_fn(2, 0);
    hit_stmt(2, 0);
    hit_stmt(2, 20);

    let branch_arms_f0 = [(0, 2)];
    let branch_arms_f1 = [(0, 2)];
    let branch_arms_f2: [(u32, usize); 0] = [];

    let manifest = [
        (0, "src/main.rs", &branch_arms_f0[..]),
        (1, "src/helper.rs", &branch_arms_f1[..]),
        (2, "vendor/lib.rs", &branch_arms_f2[..]),
    ];

    let results = take_multi_hits(&manifest);

    assert_eq!(results.len(), 3);

    // Verify File 0
    let cov0 = results.get("src/main.rs").expect("file 0 missing");
    assert_eq!(cov0.f.get("0"), Some(&1));
    assert_eq!(cov0.s.get("0"), Some(&1));
    assert_eq!(cov0.s.get("5"), Some(&1));
    assert_eq!(
        cov0.s.get("10"),
        None,
        "file 1 statement leaked into file 0"
    );
    assert_eq!(
        cov0.s.get("20"),
        None,
        "file 2 statement leaked into file 0"
    );
    assert_eq!(cov0.b.get("0"), Some(&vec![1, 0]));

    // Verify File 1
    let cov1 = results.get("src/helper.rs").expect("file 1 missing");
    assert_eq!(cov1.f.get("0"), Some(&1));
    assert_eq!(cov1.s.get("0"), Some(&1));
    assert_eq!(cov1.s.get("10"), Some(&1));
    assert_eq!(cov1.s.get("5"), None, "file 0 statement leaked into file 1");
    assert_eq!(
        cov1.s.get("20"),
        None,
        "file 2 statement leaked into file 1"
    );
    assert_eq!(cov1.b.get("0"), Some(&vec![0, 1]));

    // Verify File 2
    let cov2 = results.get("vendor/lib.rs").expect("file 2 missing");
    assert_eq!(cov2.f.get("0"), Some(&1));
    assert_eq!(cov2.s.get("0"), Some(&1));
    assert_eq!(cov2.s.get("20"), Some(&1));
    assert_eq!(cov2.s.get("5"), None, "file 0 statement leaked into file 2");
    assert_eq!(
        cov2.s.get("10"),
        None,
        "file 1 statement leaked into file 2"
    );
}

#[test]
fn test_reset_clears_all_files() {
    reset();

    hit_stmt(0, 1);
    hit_stmt(1, 2);
    hit_fn(0, 3);
    hit_fn(1, 4);
    hit_branch(0, 0, 0);
    hit_branch(1, 1, 1);

    reset();

    let manifest = [(0, "src/main.rs", &[][..]), (1, "src/helper.rs", &[][..])];
    let results = take_multi_hits(&manifest);

    let cov0 = results.get("src/main.rs").unwrap();
    let cov1 = results.get("src/helper.rs").unwrap();

    assert!(cov0.s.is_empty());
    assert!(cov0.f.is_empty());
    assert!(cov0.b.is_empty());

    assert!(cov1.s.is_empty());
    assert!(cov1.f.is_empty());
    assert!(cov1.b.is_empty());
}
