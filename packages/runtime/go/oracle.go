package runtime

import (
	"math"
	"reflect"
)

// ImplicitOracle checks if a value contains unexpected nils, NaNs, or Infinities.
func ImplicitOracle(val any) bool {
	if val == nil {
		return false
	}
	return checkValue(reflect.ValueOf(val))
}

func checkValue(v reflect.Value) bool {
	if !v.IsValid() {
		return false
	}

	switch v.Kind() {
	case reflect.Pointer, reflect.Interface:
		if v.IsNil() {
			return false
		}
		return checkValue(v.Elem())

	case reflect.Float32, reflect.Float64:
		f := v.Float()
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return false
		}
		return true

	case reflect.Slice, reflect.Array:
		for i := 0; i < v.Len(); i++ {
			if !checkValue(v.Index(i)) {
				return false
			}
		}
		return true

	case reflect.Map:
		if v.IsNil() {
			return false
		}
		iter := v.MapRange()
		for iter.Next() {
			if !checkValue(iter.Key()) || !checkValue(iter.Value()) {
				return false
			}
		}
		return true

	case reflect.Struct:
		for i := 0; i < v.NumField(); i++ {
			f := v.Field(i)
			if f.CanInterface() {
				if !checkValue(f) {
					return false
				}
			}
		}
		return true

	default:
		return true
	}
}
