package com.nanofuzz.runtime.runner;

import com.nanofuzz.runtime.CoverageTracker;
import com.nanofuzz.runtime.FuzzTestResult;
import com.nanofuzz.runtime.UnsatisfiedAssumptionException;
import com.nanofuzz.runtime.ValidatorResult;
import org.jacoco.core.analysis.Analyzer;
import org.jacoco.core.analysis.CoverageBuilder;
import org.jacoco.core.analysis.IClassCoverage;
import org.jacoco.core.analysis.ICounter;
import org.jacoco.core.analysis.ILine;
import org.jacoco.core.analysis.IMethodCoverage;
import org.jacoco.core.data.ExecutionDataStore;
import org.jacoco.core.data.SessionInfoStore;
import org.jacoco.core.instr.Instrumenter;
import org.jacoco.core.runtime.IRuntime;
import org.jacoco.core.runtime.LoggerRuntime;
import org.jacoco.core.runtime.RuntimeData;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.msgpack.jackson.dataformat.MessagePackFactory;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.lang.reflect.Array;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Persistent JVM host daemon for executing Java target functions and property
 * validators under NaNofuzz supervision.
 *
 * Communicates with NaNofuzz TypeScript runner over stdio using 4-byte
 * big-endian
 * length-prefixed JSON frames.
 */
public class JavaRunnerHost {

  private static final byte[] HEARTBEAT_BYTES = new byte[] {
      0, 0, 0, 6, (byte) 0xa5, 'H', 'E', 'A', 'R', 'T'
  };
  private static final ObjectMapper MAPPER = new ObjectMapper(new MessagePackFactory());

  private static final String PlaceHolderValueKey = "____JSONN____61581952310____VALUE____";
  private static final String PlaceHolderBigIntKey = "____JSONN____61581952310____BIGINT____";
  private static final String PlaceHolderUint8ArrayKey = "____JSONN____61581952310____UINT8ARRAY____";
  private static final String PlaceHolderMapKey = "____JSONN____61581952310____MAP____";
  private static final String PlaceHolderSetKey = "____JSONN____61581952310____SET____";
  private static final String UndefinedValue = "__undefined__";

  private final String defaultClassName;
  private final String defaultMethodName;
  private final String classesDir;
  private final DataOutputStream protocolOut;
  private InstrumentingClassLoader classLoader;
  private long lastClassLoaderMtime = 0;
  private ExecutorService executor;
  private RuntimeData runtimeData;
  private Instrumenter instrumenter;
  private final Map<String, byte[]> originalBytecode = new java.util.concurrent.ConcurrentHashMap<>();

  /**
   * Constructs a new JavaRunnerHost daemon instance.
   *
   * @param defaultClassName  Default target class name
   * @param defaultMethodName Default target method name
   * @param classesDir        Directory containing compiled target .class files
   * @param protocolOut       Stream for protocol communication back to TypeScript
   *                          parent
   */
  public JavaRunnerHost(
      String defaultClassName,
      String defaultMethodName,
      String classesDir,
      OutputStream protocolOut) {
    this.defaultClassName = defaultClassName;
    this.defaultMethodName = defaultMethodName;
    this.classesDir = classesDir;
    this.protocolOut = new DataOutputStream(protocolOut);
    this.executor = createExecutor();
    initClassLoader();
  } // fn: JavaRunnerHost

  /**
   * Creates a daemon single-thread executor for executing target calls with
   * timeout control.
   *
   * @return Configured ExecutorService
   */
  private static ExecutorService createExecutor() {
    return Executors.newSingleThreadExecutor(r -> {
      Thread t = new Thread(r, "nanofuzz-runner-worker");
      t.setDaemon(true);
      return t;
    });
  } // fn: createExecutor

  /**
   * Initializes the InstrumentingClassLoader pointing to the compiled target
   * classes directory.
   */
  private void initClassLoader() {
    try {
      if (runtimeData == null) {
        runtimeData = new RuntimeData();
        IRuntime runtime = new LoggerRuntime();
        runtime.startup(runtimeData);
        instrumenter = new Instrumenter(runtime);
      }
      originalBytecode.clear();
      List<URL> urls = new ArrayList<>();
      if (classesDir != null && !classesDir.isEmpty()) {
        String[] entries = classesDir.split(java.util.regex.Pattern.quote(File.pathSeparator));
        for (String entry : entries) {
          if (!entry.isEmpty()) {
            File f = new File(entry);
            if (f.exists()) {
              urls.add(f.toURI().toURL());
              if (f.lastModified() > lastClassLoaderMtime) {
                lastClassLoaderMtime = f.lastModified();
              }
            }
          }
        }
      }
      this.classLoader = new InstrumentingClassLoader(
          urls.toArray(new URL[0]),
          getClass().getClassLoader(),
          instrumenter,
          originalBytecode);
    } catch (Exception e) {
      this.classLoader = new InstrumentingClassLoader(
          new URL[0],
          getClass().getClassLoader(),
          null,
          originalBytecode);
    }
  } // fn: initClassLoader

  /**
   * Checks if the classes directory has been modified since classloader creation
   * and re-creates the classloader to reload fresh class bytecodes if needed.
   */
  private void refreshClassLoaderIfNeeded() {
    if (classesDir != null && !classesDir.isEmpty()) {
      String[] entries = classesDir.split(java.util.regex.Pattern.quote(File.pathSeparator));
      for (String entry : entries) {
        if (!entry.isEmpty()) {
          File f = new File(entry);
          if (f.exists() && f.lastModified() > lastClassLoaderMtime) {
            initClassLoader();
            break;
          }
        }
      }
    }
  } // fn: refreshClassLoaderIfNeeded

  /**
   * Main daemon request-response event loop over stdio.
   * Reads 4-byte big-endian length-prefixed JSON frames, processes the request,
   * and writes length-prefixed responses.
   *
   * @throws IOException On pipe or stream failure
   */
  public void runLoop() throws IOException {
    // Send immediate heartbeat on startup
    protocolOut.write(HEARTBEAT_BYTES);
    protocolOut.flush();

    DataInputStream in = new DataInputStream(System.in);

    while (true) {
      int length;
      try {
        length = in.readInt();
      } catch (Exception e) {
        // EOF or pipe broken
        break;
      }

      byte[] payloadBytes = new byte[length];
      in.readFully(payloadBytes);

      @SuppressWarnings("unchecked")
      Map<String, Object> req = (Map<String, Object>) MAPPER.readValue(payloadBytes, Map.class);
      if (req == null) {
        continue;
      }

      Map<String, Object> resp = handleRequest(req);
      byte[] respBytes = MAPPER.writeValueAsBytes(resp);

      synchronized (protocolOut) {
        protocolOut.writeInt(respBytes.length);
        protocolOut.write(respBytes);
        protocolOut.flush();
      }
    }

    executor.shutdownNow();
  } // fn: runLoop

  /**
   * Processes a single fuzzer execution request.
   * Dispatches the target method call under timeout supervision, evaluates
   * companion validators, and builds the structured result dictionary.
   *
   * @param req Request dictionary
   * @return Structured response dictionary
   */
  @SuppressWarnings("unchecked")
  private Map<String, Object> handleRequest(Map<String, Object> req) {
    long seq = req.get("seq") instanceof Number n ? n.longValue() : 0;
    List<Object> rawArgs = req.get("args") instanceof List<?> list ? (List<Object>) list : Collections.emptyList();
    List<Object> args = (List<Object>) unwrapJsonn(rawArgs);
    long timeout = req.get("timeout") instanceof Number n ? n.longValue() : 0;
    List<String> validators = req.get("validators") instanceof List<?> list ? (List<String>) list
        : Collections.emptyList();

    String className = req.get("className") instanceof String s && !s.isEmpty() ? s : defaultClassName;
    String methodName = req.get("fnName") instanceof String s && !s.isEmpty() ? s : defaultMethodName;

    refreshClassLoaderIfNeeded();

    Map<String, Object> response = new LinkedHashMap<>();
    response.put("seq", seq);

    Class<?> targetClass;
    try {
      targetClass = classLoader.loadClass(className);
    } catch (ClassNotFoundException e) {
      response.put("tag", "error");
      response.put("name", "ClassNotFoundException");
      response.put("message", "Target class not found: " + className);
      response.put("source", "host");
      return response;
    }

    Method targetMethod = findMethod(targetClass, methodName, args.size());
    if (targetMethod == null) {
      response.put("tag", "error");
      response.put("name", "NoSuchMethodException");
      response.put("message", "Method " + methodName + " with " + args.size() + " args not found in " + className);
      response.put("source", "host");
      return response;
    }

    targetMethod.setAccessible(true);
    Object targetInstance = null;
    if (!Modifier.isStatic(targetMethod.getModifiers())) {
      try {
        Constructor<?> ctor = targetClass.getDeclaredConstructor();
        ctor.setAccessible(true);
        targetInstance = ctor.newInstance();
      } catch (Exception e) {
        response.put("tag", "error");
        response.put("name", e.getClass().getSimpleName());
        response.put("message", "Failed to instantiate class: " + e.getMessage());
        response.put("source", "host");
        return response;
      }
    }

    Object[] convertedArgs;
    try {
      convertedArgs = convertArgs(args, targetMethod.getParameterTypes());
    } catch (Exception e) {
      response.put("tag", "error");
      response.put("name", "IllegalArgumentException");
      response.put("message", "Argument conversion failed: " + e.getMessage());
      response.put("source", "host");
      return response;
    }

    final Object finalInstance = targetInstance;
    final Method finalMethod = targetMethod;
    final Object[] finalArgs = convertedArgs;

    if (runtimeData != null) {
      runtimeData.reset();
    }

    Callable<Object> task = () -> finalMethod.invoke(finalInstance, finalArgs);
    Future<Object> future = executor.submit(task);

    Object outputValue = null;
    Throwable caughtException = null;

    if (timeout > 0) {
      try {
        outputValue = future.get(timeout, TimeUnit.MILLISECONDS);
      } catch (TimeoutException te) {
        future.cancel(true);
        executor.shutdownNow();
        executor = createExecutor();
        response.put("tag", "timeout");
        return response;
      } catch (ExecutionException ee) {
        caughtException = ee.getCause() != null ? ee.getCause() : ee;
      } catch (InterruptedException ie) {
        future.cancel(true);
        response.put("tag", "timeout");
        return response;
      }
    } else {
      try {
        outputValue = future.get();
      } catch (ExecutionException ee) {
        caughtException = ee.getCause() != null ? ee.getCause() : ee;
      } catch (InterruptedException ie) {
        response.put("tag", "timeout");
        return response;
      }
    }

    if (caughtException instanceof InvocationTargetException ite) {
      caughtException = ite.getCause() != null ? ite.getCause() : ite;
    }

    if (caughtException instanceof UnsatisfiedAssumptionException uae) {
      response.put("tag", "skip");
      response.put("message", uae.getMessage() != null ? uae.getMessage() : "Unsatisfied assumption");
      return response;
    }

    boolean isException = caughtException != null;
    if (isException) {
      response.put("tag", "error");
      response.put("name", caughtException.getClass().getSimpleName());
      response.put("message",
          caughtException.getMessage() != null ? caughtException.getMessage() : caughtException.toString());
      response.put("stack", getStackTrace(caughtException));
      response.put("source", "put");
    } else {
      response.put("tag", "value");
      response.put("value", wrapJsonn(outputValue));
    }

    // Evaluate property validators if requested
    if (!validators.isEmpty()) {
      Map<String, Object> valMap = new LinkedHashMap<>();
      FuzzTestResult resultObj = new FuzzTestResult(args, outputValue, isException, false);

      for (String vName : validators) {
        valMap.put(vName, executeValidator(targetClass, finalInstance, vName, resultObj));
      }
      response.put("validators", valMap);
    }

    // Collect coverage data if requested
    boolean collectCoverage = req.get("coverage") == null || Boolean.TRUE.equals(req.get("coverage"));
    if (collectCoverage && runtimeData != null) {
      try {
        ExecutionDataStore execData = new ExecutionDataStore();
        SessionInfoStore sessionInfos = new SessionInfoStore();
        runtimeData.collect(execData, sessionInfos, false);

        CoverageBuilder builder = new CoverageBuilder();
        Analyzer analyzer = new Analyzer(execData, builder);
        for (Map.Entry<String, byte[]> entry : originalBytecode.entrySet()) {
          analyzer.analyzeClass(entry.getValue(), entry.getKey());
        }

        Map<String, Object> jacocoCoverage = new LinkedHashMap<>();
        for (IClassCoverage cc : builder.getClasses()) {
          Map<String, Object> classData = new LinkedHashMap<>();
          classData.put("name", cc.getName());
          classData.put("sourceFileName", cc.getSourceFileName());

          Map<String, Object> linesMap = new LinkedHashMap<>();
          for (int l = cc.getFirstLine(); l <= cc.getLastLine(); l++) {
            ILine line = cc.getLine(l);
            if (line.getStatus() != ICounter.EMPTY) {
              Map<String, Object> lineData = new LinkedHashMap<>();
              lineData.put("status", line.getStatus());
              lineData.put("coveredInstructions", line.getInstructionCounter().getCoveredCount());
              lineData.put("totalInstructions", line.getInstructionCounter().getTotalCount());
              lineData.put("coveredBranches", line.getBranchCounter().getCoveredCount());
              lineData.put("totalBranches", line.getBranchCounter().getTotalCount());
              linesMap.put(String.valueOf(l), lineData);
            }
          }
          classData.put("lines", linesMap);

          Map<String, Object> methodsMap = new LinkedHashMap<>();
          for (IMethodCoverage mc : cc.getMethods()) {
            Map<String, Object> methodData = new LinkedHashMap<>();
            methodData.put("name", mc.getName());
            methodData.put("desc", mc.getDesc());
            methodData.put("coveredInstructions", mc.getInstructionCounter().getCoveredCount());
            methodData.put("totalInstructions", mc.getInstructionCounter().getTotalCount());
            methodsMap.put(mc.getName(), methodData);
          }
          classData.put("methods", methodsMap);

          jacocoCoverage.put(cc.getName(), classData);
        }

        response.put("jacocoCoverage", jacocoCoverage);
        runtimeData.reset();
      } catch (Exception e) {
        System.err.println("Nanofuzz Coverage Collection Error: " + e.getMessage());
        e.printStackTrace(System.err);
        response.put("coverageError",
            e.getClass().getName() + ": " + (e.getMessage() != null ? e.getMessage() : e.toString()));
      }
    }

    return response;
  } // fn: handleRequest

  /**
   * Invokes a companion property validator method with the execution result.
   *
   * @param targetClass    The class containing the validator method
   * @param targetInstance Instance of the target class (if non-static)
   * @param validatorName  Name of the validator method
   * @param resultObj      The FuzzTestResult object to validate
   * @return Validator result dictionary ({tag: "value"|"error"|"skip",
   *         value/message})
   */
  private Map<String, Object> executeValidator(
      Class<?> targetClass,
      Object targetInstance,
      String validatorName,
      FuzzTestResult resultObj) {
    Map<String, Object> vRes = new LinkedHashMap<>();
    Method vm = findValidatorMethod(targetClass, validatorName);
    if (vm == null) {
      vRes.put("tag", "error");
      vRes.put("message", "Validator method not found: " + validatorName);
      return vRes;
    }

    try {
      vm.setAccessible(true);
      Object inst = Modifier.isStatic(vm.getModifiers()) ? null : targetInstance;
      Object res = vm.invoke(inst, resultObj);
      if (res instanceof ValidatorResult vr) {
        vRes.put("tag", "value");
        vRes.put("value", vr.asStr());
      } else if (res instanceof Boolean b) {
        vRes.put("tag", "value");
        vRes.put("value", b ? "pass" : "fail");
      } else if (res instanceof String s) {
        vRes.put("tag", "value");
        vRes.put("value", s);
      } else {
        vRes.put("tag", "value");
        vRes.put("value", "unknown");
      }
    } catch (Throwable t) {
      Throwable cause = t instanceof InvocationTargetException ite && ite.getCause() != null ? ite.getCause() : t;
      if (cause instanceof UnsatisfiedAssumptionException uae) {
        vRes.put("tag", "skip");
        vRes.put("message", uae.getMessage() != null ? uae.getMessage() : "Unsatisfied assumption");
      } else {
        vRes.put("tag", "error");
        vRes.put("message", cause.getMessage() != null ? cause.getMessage() : cause.toString());
      }
    }
    return vRes;
  } // fn: executeValidator

  /**
   * Locates a target method by name and parameter count across public and
   * declared methods,
   * with support for overloaded method name suffixes (e.g.
   * {@code method_paramType}).
   *
   * @param clazz      Class to search
   * @param name       Method name or disambiguated name
   * @param paramCount Expected number of parameters
   * @return Matching Method or null if not found
   */
  private Method findMethod(Class<?> clazz, String name, int paramCount) {
    for (Method m : clazz.getMethods()) {
      if (m.getName().equals(name) && m.getParameterCount() == paramCount) {
        return m;
      }
    }
    for (Method m : clazz.getDeclaredMethods()) {
      if (m.getName().equals(name) && m.getParameterCount() == paramCount) {
        return m;
      }
    }
    // Handle overload suffix if name is formatted like method_paramType
    if (name.contains("_")) {
      String baseName = name.substring(0, name.indexOf('_'));
      for (Method m : clazz.getDeclaredMethods()) {
        if (m.getName().equals(baseName) && m.getParameterCount() == paramCount) {
          return m;
        }
      }
    }
    return null;
  } // fn: findMethod

  /**
   * Locates a companion validator method by name taking exactly 1 parameter.
   *
   * @param clazz Class to search
   * @param name  Validator method name
   * @return Matching Method or null if not found
   */
  private Method findValidatorMethod(Class<?> clazz, String name) {
    for (Method m : clazz.getDeclaredMethods()) {
      if (m.getName().equals(name) && m.getParameterCount() == 1) {
        return m;
      }
    }
    for (Method m : clazz.getMethods()) {
      if (m.getName().equals(name) && m.getParameterCount() == 1) {
        return m;
      }
    }
    return null;
  } // fn: findValidatorMethod

  /**
   * Unwraps JSONN placeholder maps received over MessagePack IPC.
   *
   * @param val Raw object from MessagePack deserialization
   * @return Unwrapped Java object
   */
  @SuppressWarnings("unchecked")
  private static Object unwrapJsonn(Object val) {
    if (val instanceof Map<?, ?> map) {
      if (UndefinedValue.equals(map.get(PlaceHolderValueKey))) {
        return null;
      }
      if (map.containsKey(PlaceHolderBigIntKey)) {
        return new BigInteger(String.valueOf(map.get(PlaceHolderBigIntKey)));
      }
      if (map.containsKey(PlaceHolderUint8ArrayKey)) {
        Object raw = map.get(PlaceHolderUint8ArrayKey);
        if (raw instanceof List<?> list) {
          byte[] bytes = new byte[list.size()];
          for (int i = 0; i < list.size(); i++) {
            bytes[i] = ((Number) list.get(i)).byteValue();
          }
          return bytes;
        }
        if (raw instanceof byte[] b) {
          return b;
        }
      }
      if (map.containsKey(PlaceHolderSetKey)) {
        Object raw = map.get(PlaceHolderSetKey);
        if (raw instanceof List<?> list) {
          Set<Object> set = new LinkedHashSet<>();
          for (Object item : list) {
            set.add(unwrapJsonn(item));
          }
          return set;
        }
      }
      if (map.containsKey(PlaceHolderMapKey)) {
        Object raw = map.get(PlaceHolderMapKey);
        if (raw instanceof List<?> list) {
          Map<Object, Object> m = new LinkedHashMap<>();
          for (Object entry : list) {
            if (entry instanceof List<?> pair && pair.size() == 2) {
              m.put(unwrapJsonn(pair.get(0)), unwrapJsonn(pair.get(1)));
            }
          }
          return m;
        }
      }
      Map<String, Object> unwrapped = new LinkedHashMap<>();
      for (Map.Entry<?, ?> e : map.entrySet()) {
        unwrapped.put(String.valueOf(e.getKey()), unwrapJsonn(e.getValue()));
      }
      return unwrapped;
    }
    if (val instanceof List<?> list) {
      List<Object> unwrapped = new ArrayList<>(list.size());
      for (Object item : list) {
        unwrapped.add(unwrapJsonn(item));
      }
      return unwrapped;
    }
    return val;
  } // fn: unwrapJsonn

  /**
   * Wraps Java objects into JSONN placeholder structures for MessagePack
   * serialization.
   *
   * @param val Java value produced by target
   * @return Object serializable to MessagePack with JSONN conventions
   */
  private static Object wrapJsonn(Object val) {
    if (val == null) {
      return null;
    }
    if (val instanceof BigInteger bi) {
      return Map.of(PlaceHolderBigIntKey, bi.toString());
    }
    if (val instanceof byte[] bytes) {
      List<Integer> list = new ArrayList<>(bytes.length);
      for (byte b : bytes) {
        list.add(b & 0xff);
      }
      return Map.of(PlaceHolderUint8ArrayKey, list);
    }
    if (val instanceof Set<?> set) {
      List<Object> list = new ArrayList<>(set.size());
      for (Object item : set) {
        list.add(wrapJsonn(item));
      }
      return Map.of(PlaceHolderSetKey, list);
    }
    if (val instanceof Map<?, ?> map) {
      List<List<Object>> entries = new ArrayList<>(map.size());
      for (Map.Entry<?, ?> e : map.entrySet()) {
        entries.add(List.of(wrapJsonn(e.getKey()), wrapJsonn(e.getValue())));
      }
      return Map.of(PlaceHolderMapKey, entries);
    }
    if (val instanceof Optional<?> opt) {
      return opt.isPresent() ? wrapJsonn(opt.get()) : null;
    }
    if (val instanceof List<?> list) {
      List<Object> wrapped = new ArrayList<>(list.size());
      for (Object item : list) {
        wrapped.add(wrapJsonn(item));
      }
      return wrapped;
    }
    if (val.getClass().isArray() && !(val instanceof byte[])) {
      int len = Array.getLength(val);
      List<Object> wrapped = new ArrayList<>(len);
      for (int i = 0; i < len; i++) {
        wrapped.add(wrapJsonn(Array.get(val, i)));
      }
      return wrapped;
    }
    return val;
  } // fn: wrapJsonn

  /**
   * Converts an ordered list of untyped JSON argument values to matching target
   * parameter types.
   *
   * @param args       Untyped argument values
   * @param paramTypes Target reflection parameter types
   * @return Converted Object array ready for reflection invocation
   */
  private Object[] convertArgs(List<Object> args, Class<?>[] paramTypes) {
    Object[] converted = new Object[paramTypes.length];
    for (int i = 0; i < paramTypes.length; i++) {
      Object raw = i < args.size() ? args.get(i) : null;
      converted[i] = convertArg(raw, paramTypes[i]);
    }
    return converted;
  } // fn: convertArgs

  /**
   * Converts a single value to the target type, handling primitives, boxed types,
   * Optionals, collections, and arrays.
   *
   * @param val    Raw value from JSON
   * @param target Target class type
   * @return Coerced and converted value
   */
  @SuppressWarnings("unchecked")
  private Object convertArg(Object val, Class<?> target) {
    if (val == null) {
      if (target.isPrimitive()) {
        if (target == boolean.class)
          return false;
        if (target == byte.class)
          return (byte) 0;
        if (target == short.class)
          return (short) 0;
        if (target == int.class)
          return 0;
        if (target == long.class)
          return 0L;
        if (target == float.class)
          return 0.0f;
        if (target == double.class)
          return 0.0d;
        if (target == char.class)
          return '\0';
      }
      if (target == Optional.class) {
        return Optional.empty();
      }
      return null;
    }

    if (target == Optional.class) {
      return Optional.of(val);
    }

    if (target == int.class || target == Integer.class) {
      return val instanceof Number n ? n.intValue() : Integer.parseInt(String.valueOf(val));
    }
    if (target == long.class || target == Long.class) {
      return val instanceof Number n ? n.longValue() : Long.parseLong(String.valueOf(val));
    }
    if (target == double.class || target == Double.class) {
      return val instanceof Number n ? n.doubleValue() : Double.parseDouble(String.valueOf(val));
    }
    if (target == float.class || target == Float.class) {
      return val instanceof Number n ? n.floatValue() : Float.parseFloat(String.valueOf(val));
    }
    if (target == boolean.class || target == Boolean.class) {
      return val instanceof Boolean b ? b : Boolean.parseBoolean(String.valueOf(val));
    }
    if (target == byte.class || target == Byte.class) {
      return val instanceof Number n ? n.byteValue() : Byte.parseByte(String.valueOf(val));
    }
    if (target == short.class || target == Short.class) {
      return val instanceof Number n ? n.shortValue() : Short.parseShort(String.valueOf(val));
    }
    if (target == char.class || target == Character.class) {
      String s = String.valueOf(val);
      return s.isEmpty() ? '\0' : s.charAt(0);
    }
    if (target == String.class || target == CharSequence.class) {
      return String.valueOf(val);
    }
    if (target == BigInteger.class) {
      return new BigInteger(String.valueOf(val));
    }
    if (target == BigDecimal.class) {
      return new BigDecimal(String.valueOf(val));
    }
    if (target == java.util.function.DoubleSupplier.class) {
      String seed = (val instanceof Map<?, ?> m && m.get("seed") != null) ? String.valueOf(m.get("seed")) : "0";
      long seedLong = seed.hashCode();
      java.util.Random rng = new java.util.Random(seedLong);
      return (java.util.function.DoubleSupplier) rng::nextDouble;
    }
    if (target == byte[].class) {
      if (val instanceof List<?> list) {
        byte[] arr = new byte[list.size()];
        for (int i = 0; i < list.size(); i++) {
          arr[i] = ((Number) list.get(i)).byteValue();
        }
        return arr;
      }
      if (val instanceof byte[] b)
        return b;
    }
    if (target.isArray()) {
      Class<?> comp = target.getComponentType();
      if (val instanceof List<?> list) {
        Object arr = Array.newInstance(comp, list.size());
        for (int i = 0; i < list.size(); i++) {
          Array.set(arr, i, convertArg(list.get(i), comp));
        }
        return arr;
      }
    }
    if (target == List.class || target == Collection.class) {
      if (val instanceof List<?> list)
        return new ArrayList<>(list);
      return List.of(val);
    }
    if (target == Set.class) {
      if (val instanceof List<?> list)
        return new LinkedHashSet<>(list);
      return Set.of(val);
    }
    if (target == Map.class) {
      if (val instanceof Map<?, ?> map)
        return new LinkedHashMap<>(map);
      return Collections.emptyMap();
    }

    return val;
  } // fn: convertArg

  /**
   * Extracts a stack trace string from a Throwable.
   *
   * @param t The throwable to inspect
   * @return Full stack trace string
   */
  private static String getStackTrace(Throwable t) {
    StringWriter sw = new StringWriter();
    t.printStackTrace(new PrintWriter(sw));
    return sw.toString();
  } // fn: getStackTrace

  /**
   * Main entry point for the JVM runner host process.
   *
   * @param args Command-line arguments [defaultClass, defaultMethod, classesDir]
   */
  public static void main(String[] args) {
    PrintStream originalOut = System.out;
    // Redirect stdout to stderr so user System.out calls do not corrupt protocol
    // framing
    System.setOut(new PrintStream(new ByteArrayOutputStream() {
      @Override
      public void flush() throws IOException {
        System.err.write(buf, 0, count);
        reset();
      }
    }));

    String defaultClass = args.length > 0 ? args[0] : "";
    String defaultMethod = args.length > 1 ? args[1] : "";
    String classesDir = args.length > 2 ? args[2] : "";

    JavaRunnerHost host = new JavaRunnerHost(defaultClass, defaultMethod, classesDir, originalOut);
    try {
      host.runLoop();
    } catch (IOException e) {
      System.err.println("JavaRunnerHost exited: " + e.getMessage());
    }
  } // fn: main

  /**
   * Custom URLClassLoader that instruments classes loaded from target classpaths
   * using JaCoCo bytecode instrumentation for coverage measurement.
   */
  public static class InstrumentingClassLoader extends URLClassLoader {
    private final Instrumenter instrumenter;
    private final Map<String, byte[]> originalBytecode;

    public InstrumentingClassLoader(
        URL[] urls,
        ClassLoader parent,
        Instrumenter instrumenter,
        Map<String, byte[]> originalBytecode) {
      super(urls, parent);
      this.instrumenter = instrumenter;
      this.originalBytecode = originalBytecode;
    } // fn: InstrumentingClassLoader

    @Override
    public Class<?> loadClass(String name) throws ClassNotFoundException {
      return loadClass(name, false);
    } // fn: loadClass

    @Override
    protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
      synchronized (getClassLoadingLock(name)) {
        Class<?> c = findLoadedClass(name);
        if (c == null) {
          if (instrumenter != null && !name.startsWith("java.") && !name.startsWith("javax.")
              && !name.startsWith("com.nanofuzz.runtime.")) {
            URL res = findResource(name.replace('.', '/') + ".class");
            if (res != null) {
              try (InputStream is = res.openStream()) {
                byte[] orig = is.readAllBytes();
                originalBytecode.put(name, orig);
                byte[] inst = instrumenter.instrument(orig, name);
                c = defineClass(name, inst, 0, inst.length);
              } catch (Exception e) {
                System.err.println(
                    "Nanofuzz Instrumentation Error: Failed to instrument class " + name + ": " + e.getMessage());
                e.printStackTrace(System.err);
                throw new ClassFormatError("Failed to instrument class " + name + ": " + e.getMessage());
              }
            }
          }
          if (c == null) {
            c = super.loadClass(name, false);
          }
        }
        if (resolve) {
          resolveClass(c);
        }
        return c;
      }
    } // fn: loadClass
  } // class: InstrumentingClassLoader
} // class: JavaRunnerHost
