// Command protodesc-check validates file descriptors the way protobuf-go
// does when it loads them, which is stricter than protobuf-es.
//
// It reads a binary FileDescriptorSet from the file named by the first
// argument, builds every file with protodesc.NewFiles, and prints "ok" or
// the error.
package main

import (
	"fmt"
	"os"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/types/descriptorpb"
)

func main() {
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	var set descriptorpb.FileDescriptorSet
	if err := proto.Unmarshal(data, &set); err != nil {
		fmt.Println(err)
		return
	}
	if _, err := protodesc.NewFiles(&set); err != nil {
		fmt.Println(err)
		return
	}
	fmt.Println("ok")
}
